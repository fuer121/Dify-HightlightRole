import { nanoid } from 'nanoid';
import type { Batch, BatchLogEvent, BatchTask, ColumnMapping, ParsedWorkbook } from './types.js';
import { compileRows } from './workbooks.js';
import {
  applyDifyResult,
  DifyError,
  extractIntermediateOutputs,
  extractProgress,
  runDifyWorkflow,
  stopDifyWorkflowTask,
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
  saveTask,
  updateBatchFileName,
  updateBookName
} from './store.js';

type RunWorkflow = typeof runDifyWorkflow;
type StopWorkflow = typeof stopDifyWorkflowTask;

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

let workflowRunner: RunWorkflow = runDifyWorkflow;
let workflowStopper: StopWorkflow = stopDifyWorkflowTask;

const batches = new Map<string, Batch>();
const subscribers = new Map<string, Set<(batch: Batch) => void>>();
const deletedBatchIds = new Set<string>();

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
  if (deletedBatchIds.has(batch.id)) return;
  batch.updatedAt = now();
  saveBatch(batch);
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
  task.is_valid = undefined;
  task.paragraph_description = undefined;
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
        const intermediate = extractIntermediateOutputs(payload);
        if (intermediate.is_valid !== undefined) task.is_valid = intermediate.is_valid;
        if (intermediate.paragraph_description !== undefined) task.paragraph_description = intermediate.paragraph_description;
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
        recordFinishedRun(task);
        emit(batch);
        return;
      }
      await applyDifyResult(task, result);
      task.status = 'succeeded';
      task.finished_at = now();
      task.elapsed_seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      addEvent(batch, 'task', `第 ${task.row_no} 行执行成功`, task.id);
      recordFinishedRun(task);
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
        recordFinishedRun(task);
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
        recordFinishedRun(task);
        emit(batch);
        return;
      }
      addEvent(batch, 'task', `第 ${task.row_no} 行第 ${task.attempts} 次失败，准备重试：${message}`, task.id);
      task.error = message;
      task.progress_label = '准备重试';
      recordFinishedRun(task);
      task.error = undefined;
      emit(batch);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

function hasAnyUnfinishedWork(batch: Batch) {
  return batch.tasks.some((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused');
}

function recoverInterruptedRunningBatch(batch: Batch) {
  if (batch.status !== 'running') return;
  if (batch.tasks.some((task) => task.status === 'running')) return;

  batch.status = hasAnyUnfinishedWork(batch) ? 'idle' : 'completed';
  batch.pauseRequested = false;
  batch.finishedAt = batch.status === 'completed' ? now() : undefined;
  addEvent(batch, 'info', '已恢复异常执行状态，可继续执行');
  emit(batch);
}

async function runBatchLoop(batch: Batch, scopedTaskIds?: Set<string>) {
  if (batch.status === 'running') return;
  batch.status = 'running';
  batch.pauseRequested = false;
  batch.startedAt = batch.startedAt ?? now();
  batch.finishedAt = undefined;
  batch.tasks.forEach((task) => {
    if ((!scopedTaskIds || scopedTaskIds.has(task.id)) && task.status === 'paused' && task.pause_reason === 'batch') {
      task.status = 'queued';
      task.pause_reason = undefined;
      task.progress_label = '等待执行';
    }
  });
  addEvent(batch, 'info', scopedTaskIds ? `开始生成选中任务，共 ${scopedTaskIds.size} 个` : '开始串行执行队列');
  emit(batch);

  while (hasPendingTasks(batch, scopedTaskIds)) {
    if (batch.pauseRequested) {
      batch.tasks.forEach((task) => {
        if ((!scopedTaskIds || scopedTaskIds.has(task.id)) && task.status === 'queued') {
          task.status = 'paused';
          task.pause_reason = 'batch';
        }
      });
      batch.status = 'paused';
      addEvent(batch, 'info', '队列已暂停，当前任务已自然结束');
      emit(batch);
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
    }
  }

  if (runnableIds.size === 0) {
    addEvent(batch, 'info', `没有可生成的选中任务，已跳过 ${skipped} 个`);
    emit(batch);
    throw new Error('没有可生成的选中任务');
  }

  batch.finishedAt = undefined;
  addEvent(batch, 'info', `已选择 ${runnableIds.size} 个任务生成${skipped > 0 ? `，跳过 ${skipped} 个不可生成任务` : ''}`);
  emit(batch);
  void runBatchLoop(batch, runnableIds);
  return batch;
}

export function pauseBatch(batchId: string) {
  const batch = batches.get(batchId);
  if (!batch) throw new Error('任务清单不存在');
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
  if (!batch) throw new Error('任务清单不存在');
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

function findBatchContainingTask(taskId: string) {
  for (const batch of batches.values()) {
    if (batch.tasks.some((task) => task.id === taskId)) return batch;
  }
  return undefined;
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
  emit(batch);
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
      if (task.dify_task_id) {
        try {
          await workflowStopper(task.dify_task_id, batch.id);
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

export function continueBook(bookId: number, filters: BookTaskFilters = {}) {
  const taskListId = filters.batchId && filters.batchId !== 'all' ? filters.batchId : undefined;
  if (!taskListId) {
    throw new Error('请先选择一个上传文档任务清单后再执行生图');
  }
  const batch = batches.get(taskListId);
  if (!batch) throw new Error('任务清单不存在，请刷新后重试');
  recoverInterruptedRunningBatch(batch);
  if (batch.status === 'running') {
    const runningTask = batch.tasks.find((task) => task.input.book_id === bookId && task.status === 'running');
    const runningDetail = runningTask ? `：第 ${runningTask.row_no} 行（${runningTask.progress_label ?? '执行中'}）` : '';
    throw new Error(`当前任务清单正在执行中${runningDetail}`);
  }
  const runnableTasks = listBookTasks(bookId, { ...filters, batchId: taskListId })
    .filter((task) => task.batch_id === taskListId)
    .filter((task) => (task.status === 'queued' || task.status === 'paused' || task.status === 'failed') && !isValidationFailed(task))
    .filter((task) => task.batch_id);
  if (runnableTasks.length === 0) throw new Error('当前任务列表没有可执行的任务');
  const runnableIds = new Set(runnableTasks.map((task) => task.id));
  let queuedCount = 0;
  for (const task of batch.tasks) {
    if (!runnableIds.has(task.id)) continue;
    if (task.status === 'failed' || task.status === 'paused') resetTaskForRetry(task);
    if (task.status === 'queued') {
      task.progress_label = task.progress_label ?? '等待执行';
      queuedCount += 1;
    }
  }
  if (queuedCount === 0) throw new Error('当前任务列表没有可执行的任务');
  batch.finishedAt = undefined;
  addEvent(batch, 'info', `开始执行当前任务清单 ${queuedCount} 个任务`);
  emit(batch);
  void runBatchLoop(batch, runnableIds);
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
    saveBatch(batch);
  }
  return restored.length;
}

export function __setWorkflowControlsForTest(runner?: RunWorkflow, stopper?: StopWorkflow) {
  workflowRunner = runner ?? runDifyWorkflow;
  workflowStopper = stopper ?? stopDifyWorkflowTask;
}
