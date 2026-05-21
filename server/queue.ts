import { nanoid } from 'nanoid';
import type { Batch, BatchLogEvent, BatchTask, ColumnMapping, ParsedWorkbook } from './types.js';
import { compileRows } from './workbooks.js';
import { applyDifyResult, DifyError, extractProgress, runDifyWorkflow, stopDifyWorkflowTask, __testables } from './dify.js';

type RunWorkflow = typeof runDifyWorkflow;
type StopWorkflow = typeof stopDifyWorkflowTask;

let workflowRunner: RunWorkflow = runDifyWorkflow;
let workflowStopper: StopWorkflow = stopDifyWorkflowTask;

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

function resetTaskForRetry(task: BatchTask) {
  task.status = 'queued';
  task.attempts = 0;
  task.started_at = undefined;
  task.finished_at = undefined;
  task.elapsed_seconds = undefined;
  task.workflow_run_id = undefined;
  task.dify_task_id = undefined;
  task.progress_percent = 0;
  task.progress_label = '等待执行';
  task.pause_reason = undefined;
  task.stop_requested_at = undefined;
  task.role = undefined;
  task.title = undefined;
  task.result_files = [];
  task.result_text = undefined;
  task.raw_outputs = undefined;
  task.error = undefined;
}

function isValidationFailed(task: BatchTask) {
  return task.error?.startsWith('字段校验失败') ?? false;
}

async function runTask(batch: Batch, task: BatchTask) {
  const maxAttempts = 2;
  task.status = 'running';
  task.started_at = now();
  task.finished_at = undefined;
  task.error = undefined;
  task.result_files = [];
  task.stop_requested_at = undefined;
  task.progress_percent = 5;
  task.progress_label = '准备请求 Dify';
  addEvent(batch, 'task', `开始执行第 ${task.row_no} 行`, task.id);
  emit(batch);

  const started = Date.now();
  while (task.attempts < maxAttempts) {
    task.attempts += 1;
    emit(batch);
    try {
      const result = await workflowRunner(task, batch.id, (payload) => {
        const progress = extractProgress(payload);
        if (progress.percent !== undefined) task.progress_percent = progress.percent;
        if (progress.label) task.progress_label = progress.label;
        const maybeTaskId = __testables.extractTaskId(payload);
        if (typeof maybeTaskId === 'string') task.dify_task_id = maybeTaskId;
        emit(batch);
      });
      if (task.stop_requested_at) {
        task.status = 'paused';
        task.finished_at = now();
        task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        task.progress_percent = 0;
        task.progress_label = '已停止，可重试';
        task.pause_reason = 'stop';
        addEvent(batch, 'task', `第 ${task.row_no} 行已停止`, task.id);
        emit(batch);
        return;
      }
      await applyDifyResult(task, result);
      task.status = 'succeeded';
      task.finished_at = now();
      task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      addEvent(batch, 'task', `第 ${task.row_no} 行执行成功`, task.id);
      emit(batch);
      return;
    } catch (error) {
      if (task.stop_requested_at) {
        task.status = 'paused';
        task.finished_at = now();
        task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        task.progress_percent = 0;
        task.progress_label = '已停止，可重试';
        task.pause_reason = 'stop';
        task.error = undefined;
        addEvent(batch, 'task', `第 ${task.row_no} 行已停止`, task.id);
        emit(batch);
        return;
      }
      const message = error instanceof Error ? error.message : '任务执行失败';
      const retryable = error instanceof DifyError ? error.retryable : true;
      if (!retryable || task.attempts >= maxAttempts) {
        task.status = 'failed';
        task.finished_at = now();
        task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        task.error = message;
        task.progress_label = '执行失败';
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
    if (task.status === 'paused' && task.pause_reason === 'batch') {
      task.status = 'queued';
      task.pause_reason = undefined;
      task.progress_label = '等待执行';
    }
  });
  addEvent(batch, 'info', '开始串行执行队列');
  emit(batch);

  while (hasPendingTasks(batch)) {
    if (batch.pauseRequested) {
      batch.tasks.forEach((task) => {
        if (task.status === 'queued') {
          task.status = 'paused';
          task.pause_reason = 'batch';
        }
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
      if (task.status === 'queued') {
        task.status = 'paused';
        task.pause_reason = 'batch';
      }
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
    if (task.status === 'failed' && !isValidationFailed(task)) {
      resetTaskForRetry(task);
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

function findTask(batch: Batch, taskId: string) {
  const task = batch.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('任务不存在');
  return task;
}

export async function pauseTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  const task = findTask(batch, taskId);

  if (task.status === 'queued') {
    task.status = 'paused';
    task.progress_percent = 0;
    task.progress_label = '已暂停';
    task.pause_reason = 'task';
    addEvent(batch, 'task', `第 ${task.row_no} 行已暂停`, task.id);
    completeIfDone(batch);
    emit(batch);
    return batch;
  }

  if (task.status !== 'running') {
    throw new Error('只有排队中或执行中的任务可以暂停');
  }

  task.stop_requested_at = now();
  task.pause_reason = 'stop';
  task.progress_label = '正在停止 Dify 任务';
  addEvent(batch, 'task', `正在停止第 ${task.row_no} 行`, task.id);
  emit(batch);

  if (task.dify_task_id) {
    try {
      await workflowStopper(task.dify_task_id, batch.id);
    } catch (error) {
      task.stop_requested_at = undefined;
      task.pause_reason = undefined;
      task.progress_label = '停止失败，继续执行';
      const message = error instanceof Error ? error.message : '停止任务失败';
      addEvent(batch, 'error', `第 ${task.row_no} 行停止失败：${message}`, task.id);
      emit(batch);
      throw error;
    }
  }
  return batch;
}

export function retryTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  const task = findTask(batch, taskId);
  if (task.status === 'running' || task.status === 'queued') {
    throw new Error('执行中或排队中的任务不能重试');
  }
  if (isValidationFailed(task)) {
    throw new Error('字段校验失败的任务不能重试，请修正 Excel 后重新上传');
  }

  resetTaskForRetry(task);
  batch.finishedAt = undefined;
  addEvent(batch, 'task', `第 ${task.row_no} 行已重新排队`, task.id);
  emit(batch);
  void runBatchLoop(batch);
  return batch;
}

export async function deleteTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  const task = findTask(batch, taskId);
  if (task.status === 'running') {
    task.stop_requested_at = now();
    task.progress_label = '删除前停止 Dify 任务';
    if (task.dify_task_id) {
      try {
        await workflowStopper(task.dify_task_id, batch.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : '停止任务失败';
        addEvent(batch, 'error', `删除第 ${task.row_no} 行前停止失败，仍将移除：${message}`, task.id);
      }
    }
  }

  batch.tasks = batch.tasks.filter((item) => item.id !== taskId);
  addEvent(batch, 'task', `已删除第 ${task.row_no} 行任务`);
  completeIfDone(batch);
  emit(batch);
  return batch;
}

export function markExported(batch: Batch) {
  emit(batch);
}

export function __setWorkflowControlsForTest(runner?: RunWorkflow, stopper?: StopWorkflow) {
  workflowRunner = runner ?? runDifyWorkflow;
  workflowStopper = stopper ?? stopDifyWorkflowTask;
}
