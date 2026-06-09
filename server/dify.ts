import type { BatchTask, DifyRunResult, ResultFile, WorkflowResult } from './types.js';
import { ensureLocalFile, registerBase64File, registerRemoteFile } from './fileStore.js';

interface DifyErrorOptions {
  retryable?: boolean;
  status?: number;
}

export interface DifyWorkflowConfig {
  id: string;
  name: string;
  apiBase: string;
  apiKey?: string;
  responseMode: string;
}

export class DifyError extends Error {
  retryable: boolean;
  status?: number;

  constructor(message: string, options: DifyErrorOptions = {}) {
    super(message);
    this.name = 'DifyError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

function apiUrl(pathname: string, apiBase = process.env.DIFY_API_BASE ?? 'http://dify.qmniu.com/v1') {
  const base = apiBase;
  return `${base.replace(/\/$/, '')}${pathname}`;
}

export function getDifyWorkflowConfigs(): DifyWorkflowConfig[] {
  const primaryApiBase = process.env.DIFY_API_BASE ?? 'http://dify.qmniu.com/v1';
  const primaryResponseMode = process.env.DIFY_RESPONSE_MODE || 'streaming';
  return [
    {
      id: 'primary',
      name: process.env.DIFY_WORKFLOW_NAME ?? '线上工作流',
      apiBase: primaryApiBase,
      apiKey: process.env.DIFY_API_KEY,
      responseMode: primaryResponseMode
    },
    {
      id: 'compare',
      name: process.env.DIFY_COMPARE_WORKFLOW_NAME ?? '对照工作流',
      apiBase: process.env.DIFY_COMPARE_API_BASE ?? primaryApiBase,
      apiKey: process.env.DIFY_COMPARE_API_KEY,
      responseMode: process.env.DIFY_COMPARE_RESPONSE_MODE || primaryResponseMode
    }
  ];
}

function configuredDifyWorkflowConfigs() {
  return getDifyWorkflowConfigs().filter((config) => Boolean(config.apiKey));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractOutputs(payload: unknown): Record<string, unknown> {
  if (!isObject(payload)) return {};
  const data = payload.data;
  if (isObject(data) && isObject(data.outputs)) return data.outputs;
  if (isObject(payload.outputs)) return payload.outputs;
  return {};
}

function extractWorkflowRunId(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  if (typeof payload.workflow_run_id === 'string') return payload.workflow_run_id;
  const data = payload.data;
  if (isObject(data)) {
    if (typeof data.workflow_run_id === 'string') return data.workflow_run_id;
    if (typeof data.id === 'string') return data.id;
  }
  return undefined;
}

function extractTaskId(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  if (typeof payload.task_id === 'string') return payload.task_id;
  const data = payload.data;
  if (isObject(data) && typeof data.task_id === 'string') return data.task_id;
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function payloadNodeIdentity(payload: Record<string, unknown>) {
  const data = isObject(payload.data) ? payload.data : {};
  const nodeId =
    stringValue(payload.node_id) ??
    stringValue(payload.nodeId) ??
    stringValue(data.node_id) ??
    stringValue(data.nodeId) ??
    stringValue(data.id) ??
    stringValue(payload.id);
  const title =
    stringValue(payload.title) ??
    stringValue(payload.node_title) ??
    stringValue(payload.nodeTitle) ??
    stringValue(data.title) ??
    stringValue(data.node_title) ??
    stringValue(data.nodeTitle);
  return { nodeId, title };
}

export function extractIntermediateOutputs(payload: unknown): Pick<BatchTask, 'is_valid' | 'paragraph_description'> {
  if (!isObject(payload)) return {};
  const event = typeof payload.event === 'string' ? payload.event : undefined;
  if (event && event !== 'node_finished') return {};

  const { nodeId, title } = payloadNodeIdentity(payload);
  const outputs = extractOutputs(payload);
  const extracted: Pick<BatchTask, 'is_valid' | 'paragraph_description'> = {};

  if (nodeId === '1778480914080' || title === 'is_valid赋值') {
    extracted.is_valid = outputs.is_valid;
  }
  if (nodeId === '1778480918522' || title === '生成段落描述') {
    extracted.paragraph_description = outputString(outputs.text);
  }

  return extracted;
}

export function extractProgress(payload: unknown): { percent?: number; label?: string } {
  if (!isObject(payload)) return {};
  const event = typeof payload.event === 'string' ? payload.event : undefined;
  const data = isObject(payload.data) ? payload.data : undefined;
  const title =
    (data && typeof data.title === 'string' ? data.title : undefined) ??
    (data && typeof data.node_title === 'string' ? data.node_title : undefined);

  if (event === 'workflow_started') return { percent: 5, label: '工作流已开始' };
  if (event === 'node_started') return { percent: 25, label: title ? `执行节点：${title}` : '节点执行中' };
  if (event === 'node_finished') return { percent: 70, label: title ? `节点完成：${title}` : '节点已完成' };
  if (event === 'workflow_finished') return { percent: 100, label: '工作流已完成' };
  return {};
}

function eventErrorMessage(payload: unknown) {
  if (!isObject(payload)) return undefined;
  if (typeof payload.message === 'string') return payload.message;
  const data = payload.data;
  if (isObject(data)) {
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
  }
  return undefined;
}

function isRetryableDifyErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  const statusMatch = normalized.match(/status code\s+(\d{3})/);
  if (statusMatch) {
    return shouldRetryStatus(Number(statusMatch[1]));
  }
  return (
    normalized.includes('service_unavailable') ||
    normalized.includes('service unavailable') ||
    normalized.includes('too busy') ||
    normalized.includes('temporarily') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('rate limit') ||
    normalized.includes('overloaded')
  );
}

function failedWorkflowError(error: unknown) {
  const message = String(error ?? 'Dify 工作流执行失败');
  return new DifyError(message, { retryable: isRetryableDifyErrorMessage(message) });
}

function buildPayload(task: BatchTask, responseMode: string, batchId: string) {
  return {
    inputs: {
      book_id: task.input.book_id,
      paragraph_content: task.input.paragraph_content,
      chapter_sort: task.input.chapter_sort
    },
    response_mode: responseMode,
    user: difyUserForBatch(batchId)
  };
}

export function difyUserForBatch(batchId: string) {
  return `local-batch-${batchId}`;
}

function shouldRetryStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function runBlocking(task: BatchTask, response: Response): Promise<DifyRunResult> {
  const payload = await response.json();
  const data = isObject(payload) ? payload.data : undefined;
  if (isObject(data) && data.status === 'failed') {
    throw failedWorkflowError(data.error);
  }
  return {
    workflowRunId: extractWorkflowRunId(payload),
    taskId: extractTaskId(payload),
    outputs: extractOutputs(payload),
    raw: payload
  };
}

function parseSseBlocks(buffer: string) {
  const blocks = buffer.split(/\n\n/);
  return {
    complete: blocks.slice(0, -1),
    rest: blocks.at(-1) ?? ''
  };
}

function parseSseJson(block: string) {
  const data = block
    .split(/\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');

  if (!data || data === '[DONE]') return undefined;
  return JSON.parse(data);
}

async function runStreaming(task: BatchTask, response: Response, onEvent?: (payload: unknown) => void): Promise<DifyRunResult> {
  if (!response.body) {
    throw new DifyError('Dify streaming 响应没有 body', { retryable: true });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPayload: unknown;
  let workflowRunId: string | undefined;
  let taskId: string | undefined;
  let outputs: Record<string, unknown> = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.rest;

    for (const block of parsed.complete) {
      const payload = parseSseJson(block);
      if (!payload) continue;
      lastPayload = payload;
      onEvent?.(payload);

      const nextWorkflowRunId = extractWorkflowRunId(payload);
      if (nextWorkflowRunId) workflowRunId = nextWorkflowRunId;
      const nextTaskId = extractTaskId(payload);
      if (nextTaskId) taskId = nextTaskId;

      if (isObject(payload) && payload.event === 'error') {
        const message = eventErrorMessage(payload) ?? 'Dify streaming 返回错误';
        throw new DifyError(message, {
          retryable: isRetryableDifyErrorMessage(message)
        });
      }

      if (isObject(payload) && payload.event === 'workflow_finished') {
        const data = payload.data;
        if (isObject(data) && data.status === 'failed') {
          throw failedWorkflowError(data.error);
        }
        outputs = extractOutputs(payload);
      }
    }
  }

  if (buffer.trim()) {
    const payload = parseSseJson(buffer);
    if (payload) {
      lastPayload = payload;
      outputs = extractOutputs(payload);
      workflowRunId = extractWorkflowRunId(payload) ?? workflowRunId;
      taskId = extractTaskId(payload) ?? taskId;
      onEvent?.(payload);
    }
  }

  if (Object.keys(outputs).length === 0) {
    throw new DifyError('Dify streaming 没有返回 workflow_finished 输出', { retryable: true });
  }

  return {
    workflowRunId,
    taskId,
    outputs,
    raw: lastPayload
  };
}

export async function runDifyWorkflow(
  task: BatchTask,
  batchId: string,
  onEvent?: (payload: unknown) => void
): Promise<DifyRunResult> {
  return runDifyWorkflowWithConfig(getDifyWorkflowConfigs()[0], task, batchId, onEvent);
}

export async function runDifyWorkflowWithConfig(
  config: DifyWorkflowConfig,
  task: BatchTask,
  batchId: string,
  onEvent?: (payload: unknown) => void
): Promise<DifyRunResult> {
  if (!config.apiKey) {
    throw new DifyError(`缺少 ${config.id === 'compare' ? 'DIFY_COMPARE_API_KEY' : 'DIFY_API_KEY'}，请检查 .env.local`, {
      retryable: false
    });
  }

  let response: Response;
  try {
    response = await fetch(apiUrl('/workflows/run', config.apiBase), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: config.responseMode === 'streaming' ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(buildPayload(task, config.responseMode, batchId))
    });
  } catch (error) {
    throw new DifyError(error instanceof Error ? `${config.name}：${error.message}` : `${config.name}：Dify 网络请求失败`, {
      retryable: true
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DifyError(`${config.name} 请求失败 ${response.status}${text ? `: ${text}` : ''}`, {
      retryable: shouldRetryStatus(response.status),
      status: response.status
    });
  }

  if (config.responseMode === 'blocking') {
    return runBlocking(task, response);
  }
  return runStreaming(task, response, onEvent);
}

export async function stopDifyWorkflowTask(taskId: string, batchId: string) {
  return stopDifyWorkflowTaskWithConfig(getDifyWorkflowConfigs()[0], taskId, batchId);
}

export async function stopDifyWorkflowTaskWithConfig(config: DifyWorkflowConfig, taskId: string, batchId: string) {
  if (!config.apiKey) {
    throw new DifyError(`缺少 ${config.id === 'compare' ? 'DIFY_COMPARE_API_KEY' : 'DIFY_API_KEY'}，请检查 .env.local`, {
      retryable: false
    });
  }

  const response = await fetch(apiUrl(`/workflows/tasks/${taskId}/stop`, config.apiBase), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user: difyUserForBatch(batchId)
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DifyError(`${config.name} 停止任务失败 ${response.status}${text ? `: ${text}` : ''}`, {
      retryable: shouldRetryStatus(response.status),
      status: response.status
    });
  }

  return response.json().catch(() => ({}));
}

export async function stopDifyWorkflowTaskByWorkflowId(taskId: string, batchId: string, workflowId = 'primary') {
  const config = getDifyWorkflowConfigs().find((item) => item.id === workflowId) ?? getDifyWorkflowConfigs()[0];
  return stopDifyWorkflowTaskWithConfig(config, taskId, batchId);
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function outputString(value: unknown) {
  if (typeof value === 'string') return value;
  if (value == null) return undefined;
  return JSON.stringify(value);
}

function isBase64Image(value: string) {
  return /^data:image\/[^;]+;base64,/.test(value) || /^[A-Za-z0-9+/=]{200,}$/.test(value);
}

async function normalizeFileValue(taskId: string, value: unknown): Promise<ResultFile[]> {
  if (!value) return [];
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
      return [registerRemoteFile(taskId, value)];
    }
    if (isBase64Image(value)) {
      return [await registerBase64File(taskId, value)];
    }
    return [];
  }

  if (Array.isArray(value)) {
    const nested = await Promise.all(value.map((item) => normalizeFileValue(taskId, item)));
    return nested.flat();
  }

  if (isObject(value)) {
    const url =
      typeof value.url === 'string'
        ? value.url
        : typeof value.remote_url === 'string'
          ? value.remote_url
          : typeof value.download_url === 'string'
            ? value.download_url
            : undefined;
    const name =
      typeof value.name === 'string'
        ? value.name
        : typeof value.filename === 'string'
          ? value.filename
          : undefined;
    const mimeType =
      typeof value.mime_type === 'string'
        ? value.mime_type
        : typeof value.mimeType === 'string'
          ? value.mimeType
          : undefined;
    if (url) {
      return [registerRemoteFile(taskId, url, name, mimeType)];
    }
  }

  return [];
}

async function workflowResultFromDifyRun(
  taskId: string,
  result: DifyRunResult,
  config: Pick<DifyWorkflowConfig, 'id' | 'name'>,
  elapsedSeconds?: number
): Promise<WorkflowResult> {
  const outputs = result.outputs ?? {};
  const fileValues = [
    outputs.result,
    outputs.result_files,
    outputs.files,
    outputs.file,
    outputs.image,
    outputs.images,
    outputs.image_url,
    outputs.image_urls,
    outputs.url
  ];
  const files = (await Promise.all(fileValues.map((value) => normalizeFileValue(taskId, value)))).flat();
  const downloadErrors: string[] = [];
  for (const file of files) {
    if (file.sourceKind === 'remote') {
      try {
        await ensureLocalFile(file);
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : '图片下载失败');
      }
    }
  }
  const availableFiles = files.filter((file) => file.sourceKind !== 'remote' || file.localPath);
  return {
    workflow_id: config.id,
    workflow_name: config.name,
    status: 'succeeded',
    workflow_run_id: result.workflowRunId,
    dify_task_id: result.taskId,
    elapsed_seconds: elapsedSeconds,
    is_valid: outputs.is_valid,
    paragraph_description: outputString(outputs.paragraph_description) ?? outputString(outputs.description),
    role: toStringArray(outputs.role),
    title: outputString(outputs.title),
    result_files: availableFiles,
    result_text:
      outputString(outputs.result_text) ??
      outputString(outputs.markdown_output) ??
      (availableFiles.length === 0 ? outputString(outputs.result) ?? outputString(outputs.image_url) ?? outputString(outputs.url) : undefined),
    raw_outputs: outputs,
    error: downloadErrors.length > 0 && availableFiles.length === 0 ? `图片下载失败：${downloadErrors.join('；')}` : undefined
  };
}

function applyWorkflowResultToTask(task: BatchTask, workflowResult: WorkflowResult) {
  task.workflow_run_id = workflowResult.workflow_run_id;
  task.dify_task_id = workflowResult.dify_task_id ?? task.dify_task_id;
  task.progress_percent = 100;
  task.progress_label = '已完成';
  task.is_valid = workflowResult.is_valid ?? task.is_valid;
  task.paragraph_description = workflowResult.paragraph_description ?? task.paragraph_description;
  task.role = workflowResult.role;
  task.title = workflowResult.title;
  task.result_files = workflowResult.result_files;
  task.result_text = workflowResult.result_text;
  task.raw_outputs = workflowResult.raw_outputs;
  task.error = workflowResult.error;
}

export function applyWorkflowResultsToTask(task: BatchTask, workflowResults: WorkflowResult[]) {
  task.workflow_results = workflowResults;
  const preferredSuccess =
    workflowResults.find((result) => result.workflow_id === 'primary' && result.status === 'succeeded') ??
    workflowResults.find((result) => result.status === 'succeeded');
  if (preferredSuccess) {
    applyWorkflowResultToTask(task, preferredSuccess);
    return preferredSuccess;
  }
  task.workflow_run_id = workflowResults.find((result) => result.workflow_run_id)?.workflow_run_id;
  task.dify_task_id = workflowResults.find((result) => result.dify_task_id)?.dify_task_id ?? task.dify_task_id;
  task.result_files = [];
  task.result_text = undefined;
  task.raw_outputs = workflowResults;
  task.error = workflowResults.map((result) => `${result.workflow_name}：${result.error ?? '执行失败'}`).join('；');
  return undefined;
}

export async function applyDifyResult(task: BatchTask, result: DifyRunResult) {
  const workflowResult = await workflowResultFromDifyRun(task.id, result, getDifyWorkflowConfigs()[0]);
  task.workflow_results = [workflowResult];
  applyWorkflowResultToTask(task, workflowResult);
}

function workflowFailureResult(config: DifyWorkflowConfig, error: unknown, elapsedSeconds?: number): WorkflowResult {
  return {
    workflow_id: config.id,
    workflow_name: config.name,
    status: 'failed',
    elapsed_seconds: elapsedSeconds,
    result_files: [],
    error: error instanceof Error ? error.message : 'Dify 工作流执行失败'
  };
}

function updateRunningWorkflowResult(task: BatchTask, config: DifyWorkflowConfig, payload: unknown) {
  const difyTaskId = extractTaskId(payload);
  const workflowRunId = extractWorkflowRunId(payload);
  if (!difyTaskId && !workflowRunId) return;
  const existingResults = task.workflow_results ?? [];
  const existing = existingResults.find((result) => result.workflow_id === config.id);
  const runningResult: WorkflowResult = {
    workflow_id: config.id,
    workflow_name: config.name,
    status: 'running',
    result_files: [],
    ...existing,
    dify_task_id: difyTaskId ?? existing?.dify_task_id,
    workflow_run_id: workflowRunId ?? existing?.workflow_run_id
  };
  task.workflow_results = existing
    ? existingResults.map((result) => (result.workflow_id === config.id ? runningResult : result))
    : [...existingResults, runningResult];
}

export async function runDifyWorkflows(
  task: BatchTask,
  batchId: string,
  onEvent?: (payload: unknown) => void
): Promise<WorkflowResult[]> {
  const configs = configuredDifyWorkflowConfigs();
  if (configs.length === 0) {
    throw new DifyError('缺少 DIFY_API_KEY，请检查 .env.local', { retryable: false });
  }

  return Promise.all(
    configs.map(async (config) => {
      const started = Date.now();
      try {
        const result = await runDifyWorkflowWithConfig(config, task, batchId, (payload) => {
          updateRunningWorkflowResult(task, config, payload);
          onEvent?.(payload);
        });
        const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
        return workflowResultFromDifyRun(task.id, result, config, elapsedSeconds);
      } catch (error) {
        const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
        return workflowFailureResult(config, error, elapsedSeconds);
      }
    })
  );
}

export const __testables = {
  extractOutputs,
  extractTaskId,
  extractIntermediateOutputs,
  extractProgress,
  isRetryableDifyErrorMessage,
  parseSseBlocks,
  parseSseJson,
  normalizeFileValue,
  workflowResultFromDifyRun
};
