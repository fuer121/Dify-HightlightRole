import { nanoid } from 'nanoid';
import type { Batch, BatchLogEvent, BatchTask, ColumnMapping, DifyRunResult, ParsedWorkbook, TaskStatus, WorkflowResult } from './types.js';
import { compileRows } from './workbooks.js';
import {
  applyDifyResult,
  applyWorkflowResultsToTask,
  DifyError,
  extractIntermediateOutputs,
  extractProgress,
  runDifyWorkflows,
  stopDifyWorkflowTaskByWorkflowId,
  __testables
} from './dify.js';
import {
  createManualTask,
  createTasksForBook,
  deleteBatchFromStore,
  getBook,
  getTask,
  listBookBatches,
  listBookTasks,
  listBooks,
  listTaskRuns,
  loadBatchesFromStore,
  markTaskDeleted,
  recordTaskRun,
  saveBatch,
  saveBatchState,
  saveTask,
  updateBatchFileName,
  updateBookName
} from './store.js';
import { DEFAULT_WORKFLOW_GROUP_ID, requireActiveWorkflowGroup } from './workflowConfigs.js';

type RunWorkflow = (
  task: BatchTask,
  batchId: string,
  onEvent?: (payload: unknown) => void
) => Promise<DifyRunResult | WorkflowResult[]>;
type StopWorkflowWithGroup = (taskId: string, batchId: string, workflowId?: string, workflowGroupId?: string) => Promise<unknown>;

interface BookTaskFilters {
  status?: string;
  q?: string;
  batchId?: string;
  chapterSortFrom?: number;
  chapterSortTo?: number;
  rowNoFrom?: number;
  rowNoTo?: number;
  hasImage?: string;
  valueStatus?: string;
}

let workflowRunner: RunWorkflow = runDifyWorkflows;
let workflowStopper: StopWorkflowWithGroup = stopDifyWorkflowTaskByWorkflowId;

const batches = new Map<string, Batch>();
const subscribers = new Map<string, Set<(batch: Batch) => void>>();
const deletedBatchIds = new Set<string>();
let lastWatchdogRunAt: string | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

function now() {
  return new Date().toISOString();
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runningTimeoutMs() {
  return envNumber('TASK_RUNNING_TIMEOUT_MS', 10 * 60 * 1000);
}

function watchdogIntervalMs() {
  return envNumber('QUEUE_WATCHDOG_INTERVAL_MS', 60 * 1000);
}

function serializeTask(task: BatchTask): BatchTask {
  return {
    ...task,
    result_files: task.result_files.map((file) => ({ ...file })),
    workflow_results: task.workflow_results?.map((result) => ({
      ...result,
      result_files: result.result_files.map((file) => ({ ...file }))
    }))
  };
}

export function serializeBatch(batch: Batch) {
  return {
    ...batch,
    tasks: batch.tasks.map(serializeTask)
  };
}

function changedTaskList(tasks?: BatchTask | BatchTask[]) {
  if (!tasks) return [];
  return Array.isArray(tasks) ? tasks : [tasks];
}

function emit(batch: Batch, changedTasks?: BatchTask | BatchTask[]) {
  if (deletedBatchIds.has(batch.id)) return;
  batch.updatedAt = now();
  saveBatchState(batch);
  for (const task of changedTaskList(changedTasks)) {
    saveTask(task, batch.id);
  }
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

function continueFilterSummary(filters: BookTaskFilters = {}) {
  const summary: string[] = [];
  if (filters.status && filters.status !== 'all') summary.push(`状态=${filters.status}`);
  if (filters.hasImage && filters.hasImage !== 'all') summary.push(`图片=${filters.hasImage}`);
  if (filters.valueStatus && filters.valueStatus !== 'all') summary.push(`价值=${filters.valueStatus}`);
  if (filters.chapterSortFrom !== undefined || filters.chapterSortTo !== undefined) {
    summary.push(`章节=${filters.chapterSortFrom ?? '-'}-${filters.chapterSortTo ?? '-'}`);
  }
  if (filters.rowNoFrom !== undefined || filters.rowNoTo !== undefined) {
    summary.push(`行号=${filters.rowNoFrom ?? '-'}-${filters.rowNoTo ?? '-'}`);
  }
  if (filters.q?.trim()) summary.push(`关键词=${filters.q.trim()}`);
  return summary.length > 0 ? summary.join('，') : '全部任务';
}

export function getBatch(batchId: string) {
  return batches.get(batchId);
}

export function renameBatch(batchId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('任务清单名称不能为空');
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  batch.fileName = trimmed;
  batch.updatedAt = now();
  updateBatchFileName(batchId, trimmed);
  emit(batch);
  return batch;
}

interface CreateBatchOptions {
  rowLimit?: number;
}

export function createBatch(workbook: ParsedWorkbook, sheetName: string, mapping: ColumnMapping, options: CreateBatchOptions = {}) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) {
    throw new Error(`找不到工作表：${sheetName}`);
  }
  if (options.rowLimit !== undefined && options.rowLimit > sheet.rowCount) {
    throw new Error(`入队行数不能超过当前工作表 ${sheet.rowCount} 行`);
  }

  const compiledRows = compileRows(sheet, mapping, { rowLimit: options.rowLimit });
  const batchId = nanoid();
  const batch: Batch = {
    id: batchId,
    workbookId: workbook.id,
    sheetName,
    fileName: workbook.fileName,
    mapping,
    rowLimit: options.rowLimit,
    status: 'idle',
    createdAt: now(),
    updatedAt: now(),
    pauseRequested: false,
    tasks: compiledRows.map((row): BatchTask => {
      const base = {
        id: nanoid(),
        batch_id: batchId,
        source_kind: 'batch',
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

  addEvent(batch, 'info', `已创建任务清单，共 ${batch.tasks.length} 行${options.rowLimit ? `，限制前 ${options.rowLimit} 行` : ''}`);
  deletedBatchIds.delete(batch.id);
  batches.set(batch.id, batch);
  saveBatch(batch);
  return batch;
}

function hasPendingTasks(batch: Batch, scope?: Set<string>) {
  return batch.tasks.some((task) => (!scope || scope.has(task.id)) && (task.status === 'queued' || task.status === 'paused'));
}

function nextQueuedTask(batch: Batch, scope?: Set<string>) {
  return batch.tasks.find((task) => (!scope || scope.has(task.id)) && task.status === 'queued');
}

function completeIfDone(batch: Batch) {
  if (batch.tasks.some((task) => task.status === 'running' || task.status === 'queued')) {
    return;
  }
  batch.status = batch.tasks.some((task) => task.status === 'paused') ? 'paused' : 'completed';
  batch.finishedAt = now();
  addEvent(batch, 'info', batch.status === 'completed' ? '任务清单执行完成' : '任务清单已暂停');
}

function recordFinishedRun(task: BatchTask) {
  recordTaskRun(task);
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
  task.is_valid = undefined;
  task.paragraph_description = undefined;
  task.role = undefined;
  task.title = undefined;
  task.result_files = [];
  task.workflow_results = undefined;
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
  task.workflow_results = undefined;
  task.stop_requested_at = undefined;
  task.is_valid = undefined;
  task.paragraph_description = undefined;
  task.progress_percent = 5;
  task.progress_label = '准备请求 Dify';
  addEvent(batch, 'task', `开始执行第 ${task.row_no} 行`, task.id);
  emit(batch, task);

  const started = Date.now();
  while (task.attempts < maxAttempts) {
    task.attempts += 1;
    emit(batch, task);
    try {
      const result = await workflowRunner(task, batch.id, (payload) => {
        const progress = extractProgress(payload);
        if (progress.percent !== undefined) task.progress_percent = progress.percent;
        if (progress.label) task.progress_label = progress.label;
        const maybeTaskId = __testables.extractTaskId(payload);
        if (typeof maybeTaskId === 'string') task.dify_task_id = maybeTaskId;
        const intermediate = extractIntermediateOutputs(payload);
        if (intermediate.is_valid !== undefined) task.is_valid = intermediate.is_valid;
        if (intermediate.paragraph_description !== undefined) task.paragraph_description = intermediate.paragraph_description;
        emit(batch, task);
      });
      if (task.stop_requested_at) {
        task.status = 'paused';
        task.finished_at = now();
        task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        task.progress_percent = 0;
        task.progress_label = '已停止，可重试';
        task.pause_reason = 'stop';
        addEvent(batch, 'task', `第 ${task.row_no} 行已停止`, task.id);
        recordFinishedRun(task);
        emit(batch, task);
        return;
      }
      if (Array.isArray(result)) {
        const preferredSuccess = applyWorkflowResultsToTask(task, result);
        if (!preferredSuccess) {
          task.status = 'failed';
          task.finished_at = now();
          task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
          task.progress_label = '执行失败';
          addEvent(batch, 'error', `第 ${task.row_no} 行失败：${task.error ?? '两个工作流均失败'}`, task.id);
          recordFinishedRun(task);
          emit(batch, task);
          return;
        }
      } else {
        await applyDifyResult(task, result);
      }
      task.status = 'succeeded';
      task.finished_at = now();
      task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      addEvent(batch, 'task', `第 ${task.row_no} 行执行成功`, task.id);
      recordFinishedRun(task);
      emit(batch, task);
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
        recordFinishedRun(task);
        emit(batch, task);
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
        recordFinishedRun(task);
        emit(batch, task);
        return;
      }
      addEvent(batch, 'task', `第 ${task.row_no} 行第 ${task.attempts} 次失败，准备重试：${message}`, task.id);
      task.error = message;
      task.progress_label = '准备重试';
      recordFinishedRun(task);
      task.error = undefined;
      emit(batch, task);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

function hasAnyUnfinishedWork(batch: Batch) {
  return batch.tasks.some((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused');
}

function isStaleRunningTask(task: BatchTask, referenceTime = Date.now()) {
  if (task.status !== 'running') return false;
  const startedAt = Date.parse(task.started_at ?? '');
  if (!Number.isFinite(startedAt)) return true;
  return referenceTime - startedAt >= runningTimeoutMs();
}

function pauseStaleRunningTask(batch: Batch, task: BatchTask) {
  task.status = 'paused';
  task.finished_at = now();
  task.progress_percent = 0;
  task.progress_label = '任务执行超时，已自动暂停，可重试';
  task.pause_reason = 'stop';
  task.stop_requested_at = undefined;
  task.error = '任务执行超时，已自动暂停，可重试';
  for (const result of task.workflow_results ?? []) {
    if (result.status === 'running') {
      result.status = 'failed';
      result.error = result.error ?? '任务执行超时，已自动暂停，可重试';
    }
  }
  addEvent(batch, 'error', `第 ${task.row_no} 行执行超时，已自动暂停，可重试`, task.id);
}

function recoverStaleRunningTasks(batch: Batch, referenceTime = Date.now()) {
  const staleTasks = batch.tasks.filter((task) => isStaleRunningTask(task, referenceTime));
  if (staleTasks.length === 0) return [];
  for (const task of staleTasks) {
    void stopRunningTask(batch, task, '超时停止 Dify 任务', true).catch(() => undefined);
    pauseStaleRunningTask(batch, task);
  }
  if (!batch.tasks.some((task) => task.status === 'running')) {
    batch.status = hasAnyUnfinishedWork(batch) ? 'idle' : 'completed';
    batch.pauseRequested = false;
    batch.finishedAt = batch.status === 'completed' ? now() : undefined;
  }
  emit(batch, staleTasks);
  return staleTasks;
}

function recoverInterruptedRunningBatch(batch: Batch) {
  if (batch.status !== 'running') return [];
  const staleTasks = recoverStaleRunningTasks(batch);
  if (batch.tasks.some((task) => task.status === 'running')) return staleTasks;

  batch.status = hasAnyUnfinishedWork(batch) ? 'idle' : 'completed';
  batch.pauseRequested = false;
  batch.finishedAt = batch.status === 'completed' ? now() : undefined;
  addEvent(batch, 'info', '已恢复异常执行状态，可继续执行');
  emit(batch);
  return staleTasks;
}

async function runBatchLoop(batch: Batch, scopedTaskIds?: Set<string>) {
  if (batch.status === 'running') return;
  batch.status = 'running';
  batch.pauseRequested = false;
  batch.startedAt = batch.startedAt ?? now();
  batch.finishedAt = undefined;
  const requeuedTasks: BatchTask[] = [];
  batch.tasks.forEach((task) => {
    if ((!scopedTaskIds || scopedTaskIds.has(task.id)) && task.status === 'paused' && task.pause_reason === 'batch') {
      task.status = 'queued';
      task.pause_reason = undefined;
      task.progress_label = '等待执行';
      requeuedTasks.push(task);
    }
  });
  addEvent(batch, 'info', scopedTaskIds ? `开始生成选中任务，共 ${scopedTaskIds.size} 个` : '开始串行执行队列');
  emit(batch, requeuedTasks);

  while (hasPendingTasks(batch, scopedTaskIds)) {
    if (batch.pauseRequested) {
      const pausedTasks: BatchTask[] = [];
      batch.tasks.forEach((task) => {
        if ((!scopedTaskIds || scopedTaskIds.has(task.id)) && task.status === 'queued') {
          task.status = 'paused';
          task.pause_reason = 'batch';
          pausedTasks.push(task);
        }
      });
      batch.status = 'paused';
      addEvent(batch, 'info', '队列已暂停，当前任务已自然结束');
      emit(batch, pausedTasks);
      return;
    }

    const task = nextQueuedTask(batch, scopedTaskIds);
    if (!task) break;
    await runTask(batch, task);
  }

  if (scopedTaskIds && hasAnyUnfinishedWork(batch)) {
    batch.status = 'idle';
    batch.finishedAt = undefined;
    addEvent(batch, 'info', '选中任务生成完成，仍有未执行任务');
    emit(batch);
    return;
  }

  completeIfDone(batch);
  emit(batch);
}

export function startBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  void runBatchLoop(batch);
  return batch;
}

export function startSelectedTasks(batchId: string, taskIds: string[]) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  recoverInterruptedRunningBatch(batch);
  if (batch.status === 'running') throw new Error('任务清单执行中，不能启动选中任务');

  const selectedIds = Array.from(new Set(taskIds));
  const runnableIds = new Set<string>();
  const changedTasks: BatchTask[] = [];
  let skipped = 0;
  for (const taskId of selectedIds) {
    const task = batch.tasks.find((item) => item.id === taskId);
    if (!task) {
      skipped += 1;
      continue;
    }
    if (task.status === 'running' || isValidationFailed(task)) {
      skipped += 1;
      continue;
    }
    if (task.status === 'failed' || task.status === 'paused' || task.status === 'succeeded') {
      resetTaskForRetry(task);
    }
    if (task.status === 'queued') {
      task.progress_label = task.progress_label ?? '等待执行';
      runnableIds.add(task.id);
      changedTasks.push(task);
    }
  }

  if (runnableIds.size === 0) {
    addEvent(batch, 'info', `没有可生成的选中任务，已跳过 ${skipped} 个`);
    emit(batch);
    throw new Error('没有可生成的选中任务');
  }

  batch.finishedAt = undefined;
  addEvent(batch, 'info', `已选择 ${runnableIds.size} 个任务生成${skipped > 0 ? `，跳过 ${skipped} 个不可生成任务` : ''}`);
  emit(batch, changedTasks);
  void runBatchLoop(batch, runnableIds);
  return batch;
}

export function pauseBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  batch.pauseRequested = true;
  const changedTasks: BatchTask[] = [];
  if (batch.status !== 'running') {
    batch.tasks.forEach((task) => {
      if (task.status === 'queued') {
        task.status = 'paused';
        task.pause_reason = 'batch';
        changedTasks.push(task);
      }
    });
    batch.status = 'paused';
  }
  addEvent(batch, 'info', '已请求暂停：当前运行任务完成后停止');
  emit(batch, changedTasks);
  return batch;
}

export function retryFailed(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  let count = 0;
  const changedTasks: BatchTask[] = [];
  batch.tasks.forEach((task) => {
    if (task.status === 'failed' && !isValidationFailed(task)) {
      resetTaskForRetry(task);
      count += 1;
      changedTasks.push(task);
    }
  });
  addEvent(batch, 'info', `已重新排队 ${count} 个失败任务`);
  emit(batch, changedTasks);
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

function findBatchContainingTask(taskId: string) {
  for (const batch of batches.values()) {
    if (batch.tasks.some((task) => task.id === taskId)) return batch;
  }
  return undefined;
}

function workflowTaskRefs(task: BatchTask) {
  const fallbackGroupId = task.workflow_group_id ?? DEFAULT_WORKFLOW_GROUP_ID;
  const refs = new Map<string, { taskId: string; workflowId: string; workflowGroupId: string }>();
  for (const result of task.workflow_results ?? []) {
    const workflowGroupId = result.workflow_group_id ?? fallbackGroupId;
    if (result.dify_task_id) {
      refs.set(`${result.workflow_id}:${workflowGroupId}:${result.dify_task_id}`, {
        taskId: result.dify_task_id,
        workflowId: result.workflow_id,
        workflowGroupId
      });
    }
  }
  if (task.dify_task_id && ![...refs.values()].some((ref) => ref.taskId === task.dify_task_id)) {
    refs.set(`primary:${fallbackGroupId}:${task.dify_task_id}`, { taskId: task.dify_task_id, workflowId: 'primary', workflowGroupId: fallbackGroupId });
  }
  return [...refs.values()];
}

export async function pauseTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  const task = findTask(batch, taskId);

  if (task.status === 'queued') {
    task.status = 'paused';
    task.progress_percent = 0;
    task.progress_label = '已暂停';
    task.pause_reason = 'task';
    addEvent(batch, 'task', `第 ${task.row_no} 行已暂停`, task.id);
    completeIfDone(batch);
    emit(batch, task);
    return batch;
  }

  if (task.status !== 'running') {
    throw new Error('只有排队中或执行中的任务可以暂停');
  }

  task.stop_requested_at = now();
  task.pause_reason = 'stop';
  task.progress_label = '正在停止 Dify 任务';
  addEvent(batch, 'task', `正在停止第 ${task.row_no} 行`, task.id);
  emit(batch, task);

  const refs = workflowTaskRefs(task);
  if (refs.length > 0) {
    try {
      await Promise.all(refs.map((ref) => workflowStopper(ref.taskId, batch.id, ref.workflowId, ref.workflowGroupId)));
    } catch (error) {
      task.stop_requested_at = undefined;
      task.pause_reason = undefined;
      task.progress_label = '停止失败，继续执行';
      const message = error instanceof Error ? error.message : '停止任务失败';
      addEvent(batch, 'error', `第 ${task.row_no} 行停止失败：${message}`, task.id);
      emit(batch, task);
      throw error;
    }
  }
  return batch;
}

export function retryTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
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
  emit(batch, task);
  void runBatchLoop(batch, new Set([task.id]));
  return batch;
}

export async function deleteTask(batchId: string, taskId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  const task = findTask(batch, taskId);
  if (task.status === 'running') {
    task.stop_requested_at = now();
    task.progress_label = '删除前停止 Dify 任务';
    const refs = workflowTaskRefs(task);
    if (refs.length > 0) {
      try {
        await Promise.all(refs.map((ref) => workflowStopper(ref.taskId, batch.id, ref.workflowId, ref.workflowGroupId)));
      } catch (error) {
        const message = error instanceof Error ? error.message : '停止任务失败';
        addEvent(batch, 'error', `删除第 ${task.row_no} 行前停止失败，仍将移除：${message}`, task.id);
      }
    }
  }

  batch.tasks = batch.tasks.filter((item) => item.id !== taskId);
  markTaskDeleted(taskId);
  addEvent(batch, 'task', `已删除第 ${task.row_no} 行任务`);
  completeIfDone(batch);
  emit(batch);
  return batch;
}

export async function deleteBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
  for (const task of batch.tasks) {
    if (task.status === 'running') {
      task.stop_requested_at = now();
      task.progress_label = '删除任务清单前停止 Dify 任务';
      const refs = workflowTaskRefs(task);
      if (refs.length > 0) {
        try {
          await Promise.all(refs.map((ref) => workflowStopper(ref.taskId, batch.id, ref.workflowId, ref.workflowGroupId)));
        } catch (error) {
          const message = error instanceof Error ? error.message : '停止任务失败';
          addEvent(batch, 'error', `删除任务清单前停止第 ${task.row_no} 行失败：${message}`, task.id);
        }
      }
    }
  }
  batches.delete(batchId);
  deletedBatchIds.add(batchId);
  subscribers.get(batchId)?.clear();
  subscribers.delete(batchId);
  deleteBatchFromStore(batchId);
}

export function markExported(batch: Batch) {
  emit(batch);
}

function validateManualInput(input: { book_id?: unknown; paragraph_content?: unknown; chapter_sort?: unknown }) {
  const bookId = Number(String(input.book_id ?? '').trim().replace(/,/g, ''));
  if (!Number.isFinite(bookId)) throw new Error('书籍 ID 必须是数字');
  const chapterSort = Number(String(input.chapter_sort ?? '').trim().replace(/,/g, ''));
  if (!Number.isFinite(chapterSort)) throw new Error('章节序号必须是数字');
  const paragraph = String(input.paragraph_content ?? '').trim();
  if (!paragraph) throw new Error('段落内容为空');
  if (paragraph.length > 100000) throw new Error('段落内容超过 100000 字符');
  return {
    book_id: bookId,
    paragraph_content: paragraph,
    chapter_sort: chapterSort
  };
}

export function listBookSummaries(query = '') {
  return listBooks(query);
}

export function getBookDetail(bookId: number) {
  return getBook(bookId);
}

export function renameBook(bookId: number, name: string) {
  return updateBookName(bookId, name);
}

export function listBatchesForBook(bookId: number) {
  return listBookBatches(bookId);
}

export function listTasksForBook(
  bookId: number,
  filters: BookTaskFilters = {}
) {
  return listBookTasks(bookId, filters);
}

export function getTaskRuns(taskId: string) {
  return listTaskRuns(taskId);
}

export function addManualBookTask(input: { book_id?: unknown; paragraph_content?: unknown; chapter_sort?: unknown }) {
  return createManualTask(validateManualInput(input));
}

export function appendBookTasks(bookId: number, tasks: BatchTask[]) {
  if (tasks.length === 0) throw new Error('没有可追加的任务');
  createTasksForBook(bookId, tasks);
}

export function appendWorkbookTasksToBook(
  bookId: number,
  workbook: ParsedWorkbook,
  sheetName: string,
  mapping: ColumnMapping,
  options: CreateBatchOptions = {}
) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  const compiledRows = compileRows(sheet, mapping, { rowLimit: options.rowLimit });
  const tasks = compiledRows.map((row): BatchTask => {
    const base = {
      id: nanoid(),
      row_no: row.row_no,
      input: {
        ...row.input,
        book_id: bookId
      },
      attempts: 0,
      progress_percent: 0,
      progress_label: '等待执行',
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
  });
  appendBookTasks(bookId, tasks);
  return tasks;
}

export function continueBook(bookId: number, filters: BookTaskFilters = {}, options: { workflowGroupId?: string } = {}) {
  const taskListId = filters.batchId && filters.batchId !== 'all' ? filters.batchId : undefined;
  if (!taskListId) {
    throw new Error('请先选择一个上传文档任务清单后再执行生图');
  }
  const workflowGroup = requireActiveWorkflowGroup(options.workflowGroupId?.trim() || DEFAULT_WORKFLOW_GROUP_ID);
  const batch = batches.get(taskListId);
  if (!batch) throw new Error('任务清单不存在，请刷新后重试');
  const recoveredStaleIds = new Set(recoverInterruptedRunningBatch(batch).map((task) => task.id));
  if (batch.status === 'running') {
    const runningTask = batch.tasks.find((task) => task.input.book_id === bookId && task.status === 'running');
    const runningDetail = runningTask ? `：第 ${runningTask.row_no} 行（${runningTask.progress_label ?? '执行中'}）` : '';
    throw new Error(`当前任务清单正在执行中${runningDetail}`);
  }
  const runnableTasks = listBookTasks(bookId, { ...filters, batchId: taskListId })
    .filter((task) => task.batch_id === taskListId)
    .filter((task) => !recoveredStaleIds.has(task.id))
    .filter(
      (task) =>
        (task.status === 'queued' || task.status === 'paused' || task.status === 'failed' || task.status === 'succeeded') &&
        !isValidationFailed(task)
    )
    .filter((task) => task.batch_id);
  if (runnableTasks.length === 0) throw new Error('当前任务列表没有可执行的任务');
  const runnableIds = new Set(runnableTasks.map((task) => task.id));
  let queuedCount = 0;
  const changedTasks: BatchTask[] = [];
  for (const task of batch.tasks) {
    if (!runnableIds.has(task.id)) continue;
    if (task.status === 'failed' || task.status === 'paused' || task.status === 'succeeded') resetTaskForRetry(task);
    if (task.status === 'queued') {
      task.progress_label = task.progress_label ?? '等待执行';
      if (!task.workflow_group_id) {
        task.workflow_group_id = workflowGroup.id;
        task.workflow_group_name = workflowGroup.name;
      }
      queuedCount += 1;
      changedTasks.push(task);
    }
  }
  if (queuedCount === 0) throw new Error('当前任务列表没有可执行的任务');
  batch.finishedAt = undefined;
  addEvent(batch, 'info', `开始执行当前任务清单 ${queuedCount} 个任务（范围：${continueFilterSummary(filters)}；未绑定任务默认 Workflow 分组=${workflowGroup.name}/${workflowGroup.id}，已绑定任务保留原分组）`);
  emit(batch, changedTasks);
  void runBatchLoop(batch, runnableIds);
  return batch;
}

function requireBookBatch(filters: BookTaskFilters, action: string) {
  const taskListId = filters.batchId && filters.batchId !== 'all' ? filters.batchId : undefined;
  if (!taskListId) {
    throw new Error(`请先选择一个上传文档任务清单后再${action}`);
  }
  const batch = batches.get(taskListId);
  if (!batch) throw new Error('任务清单不存在，请刷新后重试');
  return { batch, taskListId };
}

function scopedBookTaskIds(bookId: number, filters: BookTaskFilters, statuses: TaskStatus[]) {
  const allowed = new Set<TaskStatus>(statuses);
  return new Set(
    listBookTasks(bookId, filters)
      .filter((task) => task.batch_id === filters.batchId)
      .filter((task) => allowed.has(task.status))
      .filter((task) => !isValidationFailed(task))
      .map((task) => task.id)
  );
}

async function stopRunningTask(batch: Batch, task: BatchTask, label: string, bestEffort: boolean) {
  task.stop_requested_at = task.stop_requested_at ?? now();
  task.pause_reason = 'stop';
  task.progress_label = label;
  const refs = workflowTaskRefs(task);
  if (refs.length === 0) return;
  try {
    await Promise.all(refs.map((ref) => workflowStopper(ref.taskId, batch.id, ref.workflowId, ref.workflowGroupId)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '停止任务失败';
    addEvent(batch, 'error', `第 ${task.row_no} 行停止失败：${message}`, task.id);
    if (!bestEffort) throw error;
  }
}

export function getQueueHealthSnapshot() {
  const referenceTime = Date.now();
  let runningTasks = 0;
  let staleRunningTasks = 0;
  for (const batch of batches.values()) {
    for (const task of batch.tasks) {
      if (task.status !== 'running') continue;
      runningTasks += 1;
      if (isStaleRunningTask(task, referenceTime)) staleRunningTasks += 1;
    }
  }
  return {
    runningTasks,
    staleRunningTasks,
    lastWatchdogRunAt,
    watchdogEnabled: true,
    runningTimeoutMs: runningTimeoutMs(),
    watchdogIntervalMs: watchdogIntervalMs()
  };
}

export async function runQueueWatchdogOnce() {
  lastWatchdogRunAt = now();
  const referenceTime = Date.now();
  for (const batch of batches.values()) {
    const staleTasks = batch.tasks.filter((task) => isStaleRunningTask(task, referenceTime));
    if (staleTasks.length === 0) continue;
    for (const task of staleTasks) {
      await stopRunningTask(batch, task, '超时停止 Dify 任务', true);
      pauseStaleRunningTask(batch, task);
    }
    if (!batch.tasks.some((task) => task.status === 'running')) {
      batch.status = hasAnyUnfinishedWork(batch) ? 'idle' : 'completed';
      batch.pauseRequested = false;
      batch.finishedAt = batch.status === 'completed' ? now() : undefined;
    }
    emit(batch, staleTasks);
  }
  return getQueueHealthSnapshot();
}

export function startQueueWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void runQueueWatchdogOnce();
  }, watchdogIntervalMs());
  watchdogTimer.unref?.();
}

export async function pauseBookTasks(bookId: number, filters: BookTaskFilters = {}) {
  const { batch, taskListId } = requireBookBatch(filters, '暂停生图');
  const scopedIds = scopedBookTaskIds(bookId, { ...filters, batchId: taskListId }, ['queued', 'running']);
  if (scopedIds.size === 0) throw new Error('当前任务列表没有可暂停的任务');

  batch.pauseRequested = true;
  let pausedCount = 0;
  let stoppingCount = 0;
  const changedTasks: BatchTask[] = [];
  for (const task of batch.tasks) {
    if (!scopedIds.has(task.id)) continue;
    if (task.status === 'queued') {
      task.status = 'paused';
      task.progress_percent = 0;
      task.progress_label = '已暂停';
      task.pause_reason = 'batch';
      pausedCount += 1;
      changedTasks.push(task);
    } else if (task.status === 'running') {
      stoppingCount += 1;
      await stopRunningTask(batch, task, '正在停止 Dify 任务', false);
      changedTasks.push(task);
    }
  }

  if (batch.status !== 'running') {
    batch.status = 'paused';
  }
  addEvent(batch, 'info', `已请求暂停当前任务列表范围：停止中 ${stoppingCount} 个，已暂停 ${pausedCount} 个`);
  emit(batch, changedTasks);
  return batch;
}

export async function cancelBookTasks(bookId: number, filters: BookTaskFilters = {}) {
  const { batch, taskListId } = requireBookBatch(filters, '取消生图');
  const scopedIds = scopedBookTaskIds(bookId, { ...filters, batchId: taskListId }, ['queued', 'running', 'paused']);
  if (scopedIds.size === 0) throw new Error('当前任务列表没有可取消的未完成任务');

  let canceledCount = 0;
  let stoppedRunning = false;
  for (const task of [...batch.tasks]) {
    if (!scopedIds.has(task.id)) continue;
    if (task.status === 'running') {
      stoppedRunning = true;
      await stopRunningTask(batch, task, '取消前停止 Dify 任务', true);
    }
    markTaskDeleted(task.id);
    canceledCount += 1;
  }
  batch.tasks = batch.tasks.filter((task) => !scopedIds.has(task.id));
  batch.pauseRequested = stoppedRunning;
  if (!batch.tasks.some((task) => task.status === 'running')) {
    batch.status = hasAnyUnfinishedWork(batch) ? 'idle' : 'completed';
    batch.finishedAt = batch.status === 'completed' ? now() : undefined;
  }
  addEvent(batch, 'info', `已取消当前任务列表范围内 ${canceledCount} 个未完成任务，已生成结果保留`);
  completeIfDone(batch);
  emit(batch);
  return batch;
}

export async function pauseStoredTask(taskId: string) {
  const batch = findBatchContainingTask(taskId);
  if (batch) return pauseTask(batch.id, taskId);
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'queued') throw new Error('只有排队中的历史任务可以暂停');
  task.status = 'paused';
  task.pause_reason = 'task';
  task.progress_percent = 0;
  task.progress_label = '已暂停';
  saveTask(task);
  return task;
}

export function retryStoredTask(taskId: string) {
  const batch = findBatchContainingTask(taskId);
  if (batch) return retryTask(batch.id, taskId);
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.batch_id) {
    const taskBatch = batches.get(task.batch_id);
    if (taskBatch) return retryTask(taskBatch.id, taskId);
    throw new Error('任务清单不存在，请刷新后重试');
  }
  if (task.status === 'running' || task.status === 'queued') throw new Error('执行中或排队中的任务不能重试');
  if (isValidationFailed(task)) throw new Error('字段校验失败的任务不能重试，请修正 Excel 后重新上传');
  throw new Error('该任务不属于上传文档任务清单，无法重新生图');
}

export async function deleteStoredTask(taskId: string) {
  const batch = findBatchContainingTask(taskId);
  if (batch) return deleteTask(batch.id, taskId);
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('运行中的任务需要在任务清单中停止后删除');
  markTaskDeleted(taskId);
  return task;
}

export function hydrateBatchesFromStore() {
  const restored = loadBatchesFromStore();
  for (const batch of restored) {
    batches.set(batch.id, batch);
  }
  return restored.length;
}

export function __setWorkflowControlsForTest(runner?: RunWorkflow, stopper?: StopWorkflowWithGroup) {
  workflowRunner = runner ?? runDifyWorkflows;
  workflowStopper = stopper ?? stopDifyWorkflowTaskByWorkflowId;
}

export function __resetQueueForTest() {
  batches.clear();
  subscribers.clear();
  deletedBatchIds.clear();
  lastWatchdogRunAt = null;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  }
  __setWorkflowControlsForTest();
}
