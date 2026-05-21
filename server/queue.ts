import { nanoid } from 'nanoid';
import type { Batch, BatchLogEvent, BatchTask, ColumnMapping, ParsedWorkbook } from './types.js';
import { compileRows } from './workbooks.js';
import { applyDifyResult, DifyError, runDifyWorkflow } from './dify.js';

const batches = new Map<string, Batch>();
const subscribers = new Map<string, Set<(batch: Batch) => void>>();

function now() {
  return new Date().toISOString();
}

function serializeTask(task: BatchTask): BatchTask {
  return {
    ...task,
    result_files: task.result_files.map((file) => ({ ...file }))
  };
}

export function serializeBatch(batch: Batch) {
  return {
    ...batch,
    tasks: batch.tasks.map(serializeTask)
  };
}

function emit(batch: Batch) {
  batch.updatedAt = now();
  const listeners = subscribers.get(batch.id);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(batch);
  }
}

export function subscribeBatch(batchId: string, listener: (batch: Batch) => void) {
  let listeners = subscribers.get(batchId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(batchId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) subscribers.delete(batchId);
  };
}

function addEvent(batch: Batch, type: BatchLogEvent['type'], message: string, taskId?: string) {
  batch.events.unshift({
    id: nanoid(),
    type,
    message,
    taskId,
    createdAt: now()
  });
  batch.events = batch.events.slice(0, 120);
}

export function getBatch(batchId: string) {
  return batches.get(batchId);
}

export function createBatch(workbook: ParsedWorkbook, sheetName: string, mapping: ColumnMapping) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) {
    throw new Error(`找不到工作表：${sheetName}`);
  }

  const compiledRows = compileRows(sheet, mapping);
  const batch: Batch = {
    id: nanoid(),
    workbookId: workbook.id,
    sheetName,
    fileName: workbook.fileName,
    mapping,
    status: 'idle',
    createdAt: now(),
    updatedAt: now(),
    pauseRequested: false,
    tasks: compiledRows.map((row): BatchTask => {
      const base = {
        id: nanoid(),
        row_no: row.row_no,
        input: row.input,
        attempts: 0,
        result_files: []
      };
      if (row.error) {
        return {
          ...base,
          status: 'failed',
          finished_at: now(),
          error: `字段校验失败：${row.error}`
        };
      }
      return {
        ...base,
        status: 'queued'
      };
    }),
    events: []
  };

  addEvent(batch, 'info', `已创建批次，共 ${batch.tasks.length} 行`);
  batches.set(batch.id, batch);
  return batch;
}

function hasPendingTasks(batch: Batch) {
  return batch.tasks.some((task) => task.status === 'queued' || task.status === 'paused');
}

function nextQueuedTask(batch: Batch) {
  return batch.tasks.find((task) => task.status === 'queued');
}

function completeIfDone(batch: Batch) {
  if (batch.tasks.some((task) => task.status === 'running' || task.status === 'queued')) {
    return;
  }
  batch.status = batch.tasks.some((task) => task.status === 'paused') ? 'paused' : 'completed';
  batch.finishedAt = now();
  addEvent(batch, 'info', batch.status === 'completed' ? '批次执行完成' : '批次已暂停');
}

async function runTask(batch: Batch, task: BatchTask) {
  const maxAttempts = 2;
  task.status = 'running';
  task.started_at = now();
  task.finished_at = undefined;
  task.error = undefined;
  task.result_files = [];
  addEvent(batch, 'task', `开始执行第 ${task.row_no} 行`, task.id);
  emit(batch);

  const started = Date.now();
  while (task.attempts < maxAttempts) {
    task.attempts += 1;
    emit(batch);
    try {
      const result = await runDifyWorkflow(task, batch.id);
      await applyDifyResult(task, result);
      task.status = 'succeeded';
      task.finished_at = now();
      task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      addEvent(batch, 'task', `第 ${task.row_no} 行执行成功`, task.id);
      emit(batch);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : '任务执行失败';
      const retryable = error instanceof DifyError ? error.retryable : true;
      if (!retryable || task.attempts >= maxAttempts) {
        task.status = 'failed';
        task.finished_at = now();
        task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        task.error = message;
        addEvent(batch, 'error', `第 ${task.row_no} 行失败：${message}`, task.id);
        emit(batch);
        return;
      }
      addEvent(batch, 'task', `第 ${task.row_no} 行第 ${task.attempts} 次失败，准备重试：${message}`, task.id);
      emit(batch);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

async function runBatchLoop(batch: Batch) {
  if (batch.status === 'running') return;
  batch.status = 'running';
  batch.pauseRequested = false;
  batch.startedAt = batch.startedAt ?? now();
  batch.finishedAt = undefined;
  batch.tasks.forEach((task) => {
    if (task.status === 'paused') task.status = 'queued';
  });
  addEvent(batch, 'info', '开始串行执行队列');
  emit(batch);

  while (hasPendingTasks(batch)) {
    if (batch.pauseRequested) {
      batch.tasks.forEach((task) => {
        if (task.status === 'queued') task.status = 'paused';
      });
      batch.status = 'paused';
      addEvent(batch, 'info', '队列已暂停，当前任务已自然结束');
      emit(batch);
      return;
    }

    const task = nextQueuedTask(batch);
    if (!task) break;
    await runTask(batch, task);
  }

  completeIfDone(batch);
  emit(batch);
}

export function startBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  void runBatchLoop(batch);
  return batch;
}

export function pauseBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  batch.pauseRequested = true;
  if (batch.status !== 'running') {
    batch.tasks.forEach((task) => {
      if (task.status === 'queued') task.status = 'paused';
    });
    batch.status = 'paused';
  }
  addEvent(batch, 'info', '已请求暂停：当前运行任务完成后停止');
  emit(batch);
  return batch;
}

export function retryFailed(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  let count = 0;
  batch.tasks.forEach((task) => {
    if (task.status === 'failed' && !task.error?.startsWith('字段校验失败')) {
      task.status = 'queued';
      task.started_at = undefined;
      task.finished_at = undefined;
      task.elapsed_seconds = undefined;
      task.error = undefined;
      task.result_files = [];
      task.raw_outputs = undefined;
      task.workflow_run_id = undefined;
      count += 1;
    }
  });
  addEvent(batch, 'info', `已重新排队 ${count} 个失败任务`);
  emit(batch);
  if (count > 0) {
    void runBatchLoop(batch);
  }
  return batch;
}

export function markExported(batch: Batch) {
  emit(batch);
}
