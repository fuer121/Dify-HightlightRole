import { nanoid } from 'nanoid';
import type { CharacterColumnMapping, CharacterJob, CharacterJobEvent, CharacterTask, ParsedWorkbook } from './types.js';
import { compileCharacterRows } from './workbooks.js';
import {
  getCharacterJob as loadCharacterJob,
  listCharacterJobs as loadCharacterJobs,
  listCharacterTaskRuns,
  recordCharacterTaskRun,
  saveCharacterJob,
  saveCharacterTask
} from './characterStore.js';
import { __runCharacterWorkflowForTest, __setCharacterWorkflowControlsForTest, applyCharacterDifyResult } from './characterDify.js';

const jobs = new Map<string, CharacterJob>();
const subscribers = new Map<string, Set<(job: CharacterJob) => void>>();
const activeJobs = new Set<string>();
const pauseRequests = new Set<string>();

function now() {
  return new Date().toISOString();
}

function readNonNegativeInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isRetryableCharacterError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket hang up|Service is too busy|status code 5\d\d|请求失败 5\d\d/i.test(
    message
  );
}

function emit(job: CharacterJob) {
  job.updatedAt = now();
  saveCharacterJob(job);
  const listeners = subscribers.get(job.id);
  if (!listeners) return;
  for (const listener of listeners) listener(job);
}

function addEvent(job: CharacterJob, type: CharacterJobEvent['type'], message: string, taskId?: string) {
  job.events.unshift({
    id: nanoid(),
    type,
    message,
    taskId,
    createdAt: now()
  });
  job.events = job.events.slice(0, 160);
}

function completeIfDone(job: CharacterJob) {
  if (job.tasks.some((task) => task.status === 'queued' || task.status === 'running' || task.status === 'paused')) return;
  job.status = 'completed';
  job.finishedAt = now();
  addEvent(job, 'info', '角色形象提取任务已完成');
}

function resetTaskForRetry(task: CharacterTask) {
  task.status = 'queued';
  task.attempts = 0;
  task.started_at = undefined;
  task.finished_at = undefined;
  task.elapsed_seconds = undefined;
  task.workflow_run_id = undefined;
  task.dify_task_id = undefined;
  task.progress_percent = 0;
  task.progress_label = '等待执行';
  task.extracted_role_name = undefined;
  task.extracted_description = undefined;
  task.portrait_files = [];
  task.result_text = undefined;
  task.raw_outputs = undefined;
  task.error = undefined;
}

async function runSingleTask(job: CharacterJob, task: CharacterTask) {
  task.status = 'running';
  task.attempts += 1;
  task.started_at = now();
  task.finished_at = undefined;
  task.elapsed_seconds = undefined;
  task.progress_percent = 15;
  task.progress_label = '工作流执行中';
  task.error = undefined;
  emit(job);
  try {
    const maxAutoRetries = readNonNegativeInteger('CHARACTER_DIFY_AUTO_RETRIES', 0);
    const retryDelayMs = readNonNegativeInteger('CHARACTER_DIFY_RETRY_DELAY_MS', 0);
    const result = await __runCharacterWorkflowForTest(task, job.promptText, job.id).catch(async (error) => {
      let lastError = error;
      for (let retryIndex = 1; retryIndex <= maxAutoRetries; retryIndex += 1) {
        if (!isRetryableCharacterError(lastError)) throw lastError;
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        task.progress_label = `网络异常，自动重试 ${retryIndex}/${maxAutoRetries}`;
        addEvent(job, 'error', `第 ${task.row_no} 行请求失败，自动重试 ${retryIndex}/${maxAutoRetries}：${message}`, task.id);
        emit(job);
        await delay(retryDelayMs);
        try {
          return await __runCharacterWorkflowForTest(task, job.promptText, job.id);
        } catch (nextError) {
          lastError = nextError;
        }
      }
      throw lastError;
    });
    task.workflow_run_id = result.workflowRunId;
    task.dify_task_id = result.taskId ?? task.dify_task_id;
    task.raw_outputs = result.outputs;
    await applyCharacterDifyResult(task, result);
    task.status = 'succeeded';
    task.finished_at = now();
    task.elapsed_seconds = Number(((new Date(task.finished_at).getTime() - new Date(task.started_at!).getTime()) / 1000).toFixed(1));
    recordCharacterTaskRun(task);
    addEvent(job, 'task', `第 ${task.row_no} 行立绘生成完成`, task.id);
  } catch (error) {
    task.status = 'failed';
    task.finished_at = now();
    task.elapsed_seconds = Number(((new Date(task.finished_at).getTime() - new Date(task.started_at!).getTime()) / 1000).toFixed(1));
    task.error = error instanceof Error ? error.message : '角色形象提取失败';
    recordCharacterTaskRun(task);
    addEvent(job, 'error', `第 ${task.row_no} 行执行失败：${task.error}`, task.id);
  }
  saveCharacterTask(task);
  completeIfDone(job);
  emit(job);
}

async function runJob(job: CharacterJob, scopedTaskIds?: Set<string>) {
  if (activeJobs.has(job.id)) return;
  activeJobs.add(job.id);
  try {
    const taskDelayMs = readNonNegativeInteger('CHARACTER_DIFY_TASK_DELAY_MS', 0);
    const maxTasksPerRun = readPositiveInteger('CHARACTER_DIFY_MAX_TASKS_PER_RUN', Number.POSITIVE_INFINITY);
    let processedTasks = 0;
    job.status = 'running';
    job.startedAt = job.startedAt ?? now();
    job.finishedAt = undefined;
    addEvent(job, 'info', '开始执行角色形象提取任务');
    emit(job);

    for (const task of job.tasks) {
      if (pauseRequests.has(job.id)) break;
      if (scopedTaskIds && !scopedTaskIds.has(task.id)) continue;
      if (task.status !== 'queued' && task.status !== 'running') continue;
      if (processedTasks >= maxTasksPerRun) break;
      if (processedTasks > 0) await delay(taskDelayMs);
      await runSingleTask(job, task);
      processedTasks += 1;
    }

    const scopedTasks = scopedTaskIds ? job.tasks.filter((task) => scopedTaskIds.has(task.id)) : job.tasks;
    const hasPendingScopedTask = scopedTasks.some((task) => task.status === 'queued' || task.status === 'paused');
    const hasAnyPendingTask = job.tasks.some((task) => task.status === 'queued' || task.status === 'paused');
    if (hasAnyPendingTask) {
      job.status = 'paused';
      addEvent(
        job,
        'info',
        scopedTaskIds && !hasPendingScopedTask
          ? `本次筛选范围已执行完成，共 ${processedTasks} 条；仍有未筛选任务待处理`
          : `已达到本轮样本上限 ${processedTasks} 条，队列暂停等待下一步确认`
      );
      emit(job);
    }
  } finally {
    activeJobs.delete(job.id);
  }
}

export function createCharacterJob(
  workbook: ParsedWorkbook,
  sheetName: string,
  mapping: CharacterColumnMapping,
  promptText: string
) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  const compiledRows = compileCharacterRows(sheet, mapping);
  const job: CharacterJob = {
    id: nanoid(),
    workbookId: workbook.id,
    sheetName,
    fileName: workbook.fileName,
    mapping,
    promptText,
    status: 'idle',
    createdAt: now(),
    updatedAt: now(),
    tasks: compiledRows.map((row) => {
      const task: CharacterTask = {
        id: nanoid(),
        job_id: '',
        row_no: row.row_no,
        input: row.input,
        status: row.error ? 'failed' : 'queued',
        attempts: 0,
        progress_percent: row.error ? 100 : 0,
        progress_label: row.error ? '字段校验失败' : '等待执行',
        portrait_files: [],
        error: row.error ? `字段校验失败：${row.error}` : undefined
      };
      return task;
    }),
    events: []
  };
  job.tasks.forEach((task) => {
    task.job_id = job.id;
  });
  addEvent(job, 'info', `已创建角色形象提取任务，共 ${job.tasks.length} 行`);
  jobs.set(job.id, job);
  saveCharacterJob(job);
  return job;
}

export function getCharacterJob(jobId: string) {
  return jobs.get(jobId) ?? loadCharacterJob(jobId);
}

export function listCharacterJobs() {
  return loadCharacterJobs();
}

export function subscribeCharacterJob(jobId: string, listener: (job: CharacterJob) => void) {
  let listeners = subscribers.get(jobId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(jobId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) subscribers.delete(jobId);
  };
}

export function getCharacterTaskRuns(taskId: string) {
  return listCharacterTaskRuns(taskId);
}

export function startCharacterJob(jobId: string, taskIds?: string[]) {
  const job = getCharacterJob(jobId);
  if (!job) throw new Error('角色任务不存在');
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  pauseRequests.delete(job.id);
  const scopedTaskIds = taskIds ? new Set(taskIds) : undefined;
  if (scopedTaskIds?.size === 0) throw new Error('当前筛选范围没有可执行任务');
  if (scopedTaskIds) {
    const knownTaskIds = new Set(job.tasks.map((task) => task.id));
    for (const taskId of scopedTaskIds) {
      if (!knownTaskIds.has(taskId)) throw new Error('筛选范围包含不存在的角色任务行');
    }
  }
  for (const task of job.tasks) {
    if (scopedTaskIds && !scopedTaskIds.has(task.id)) continue;
    if (task.status === 'failed' && task.error?.startsWith('字段校验失败')) continue;
    if (task.status === 'failed' || task.status === 'paused' || task.status === 'succeeded') {
      resetTaskForRetry(task);
      saveCharacterTask(task);
    }
  }
  void runJob(job, scopedTaskIds);
  return job;
}

export function retryCharacterTask(jobId: string, taskId: string) {
  const job = getCharacterJob(jobId);
  if (!job) throw new Error('角色任务不存在');
  const task = job.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('角色任务行不存在');
  if (task.error?.startsWith('字段校验失败')) throw new Error('字段校验失败的任务不能重试');
  resetTaskForRetry(task);
  saveCharacterTask(task);
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  pauseRequests.delete(job.id);
  void runJob(job, new Set([task.id]));
  return job;
}

export function retryCharacterFailed(jobId: string) {
  const job = getCharacterJob(jobId);
  if (!job) throw new Error('角色任务不存在');
  const retryTaskIds: string[] = [];
  for (const task of job.tasks) {
    if (task.status === 'failed' && !task.error?.startsWith('字段校验失败')) {
      resetTaskForRetry(task);
      saveCharacterTask(task);
      retryTaskIds.push(task.id);
    }
  }
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  pauseRequests.delete(job.id);
  void runJob(job, new Set(retryTaskIds));
  return job;
}

export function updateCharacterJobPrompt(jobId: string, promptText: string) {
  const job = getCharacterJob(jobId);
  if (!job) throw new Error('角色任务不存在');
  const nextPrompt = promptText.trim();
  if (!nextPrompt) throw new Error('Prompt 不能为空');
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  job.promptText = nextPrompt;
  addEvent(job, 'info', '已更新角色立绘重绘 Prompt，后续执行将使用新版 Prompt');
  emit(job);
  return job;
}

export function pauseCharacterJob(jobId: string) {
  const job = getCharacterJob(jobId);
  if (!job) throw new Error('角色任务不存在');
  if (!jobs.has(job.id)) jobs.set(job.id, job);
  pauseRequests.add(job.id);
  for (const task of job.tasks) {
    if (task.status === 'queued') {
      task.status = 'paused';
      task.progress_label = '已暂停';
      saveCharacterTask(task);
    }
  }
  job.status = 'paused';
  addEvent(job, 'info', '已暂停角色形象提取任务，当前运行中的任务会在完成后停止继续取下一行');
  emit(job);
  return job;
}

export { __setCharacterWorkflowControlsForTest };
