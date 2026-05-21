import type { BatchTask, DifyRunResult, ResultFile } from './types.js';
import { registerBase64File, registerRemoteFile } from './fileStore.js';

interface DifyErrorOptions {
  retryable?: boolean;
  status?: number;
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

function apiUrl(pathname: string) {
  const base = process.env.DIFY_API_BASE ?? 'http://dify.qmniu.com/v1';
  return `${base.replace(/\/$/, '')}${pathname}`;
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
    throw new DifyError(String(data.error ?? 'Dify 工作流执行失败'), { retryable: false });
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
        throw new DifyError(eventErrorMessage(payload) ?? 'Dify streaming 返回错误', {
          retryable: false
        });
      }

      if (isObject(payload) && payload.event === 'workflow_finished') {
        const data = payload.data;
        if (isObject(data) && data.status === 'failed') {
          throw new DifyError(String(data.error ?? 'Dify 工作流执行失败'), { retryable: false });
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
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    throw new DifyError('缺少 DIFY_API_KEY，请检查 .env.local', { retryable: false });
  }

  const responseMode = process.env.DIFY_RESPONSE_MODE || 'streaming';
  let response: Response;
  try {
    response = await fetch(apiUrl('/workflows/run'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: responseMode === 'streaming' ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(buildPayload(task, responseMode, batchId))
    });
  } catch (error) {
    throw new DifyError(error instanceof Error ? error.message : 'Dify 网络请求失败', {
      retryable: true
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DifyError(`Dify 请求失败 ${response.status}${text ? `: ${text}` : ''}`, {
      retryable: shouldRetryStatus(response.status),
      status: response.status
    });
  }

  if (responseMode === 'blocking') {
    return runBlocking(task, response);
  }
  return runStreaming(task, response, onEvent);
}

export async function stopDifyWorkflowTask(taskId: string, batchId: string) {
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    throw new DifyError('缺少 DIFY_API_KEY，请检查 .env.local', { retryable: false });
  }

  const response = await fetch(apiUrl(`/workflows/tasks/${taskId}/stop`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user: difyUserForBatch(batchId)
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DifyError(`Dify 停止任务失败 ${response.status}${text ? `: ${text}` : ''}`, {
      retryable: shouldRetryStatus(response.status),
      status: response.status
    });
  }

  return response.json().catch(() => ({}));
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

export async function applyDifyResult(task: BatchTask, result: DifyRunResult) {
  const outputs = result.outputs ?? {};
  const files = await normalizeFileValue(task.id, outputs.result);
  task.workflow_run_id = result.workflowRunId;
  task.dify_task_id = result.taskId ?? task.dify_task_id;
  task.progress_percent = 100;
  task.progress_label = '已完成';
  task.role = toStringArray(outputs.role);
  task.title = outputString(outputs.title);
  task.result_files = files;
  task.result_text =
    outputString(outputs.result_text) ??
    outputString(outputs.markdown_output) ??
    (files.length === 0 ? outputString(outputs.result) : undefined);
  task.raw_outputs = outputs;
}

export const __testables = {
  extractOutputs,
  extractTaskId,
  extractProgress,
  parseSseBlocks,
  parseSseJson,
  normalizeFileValue
};
