import type { CharacterTask, DifyRunResult, ResultFile } from './types.js';
import { registerBase64File, registerRemoteFile } from './fileStore.js';

type CharacterRunWorkflow = typeof runCharacterWorkflow;

function apiUrl(pathname: string) {
  const base = process.env.CHARACTER_DIFY_API_BASE ?? process.env.DIFY_API_BASE ?? 'http://dify.qmniu.com/v1';
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

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isBase64Image(value: string) {
  return /^data:image\/[^;]+;base64,/.test(value) || /^[A-Za-z0-9+/=]{200,}$/.test(value);
}

async function normalizeFileValue(taskId: string, value: unknown): Promise<ResultFile[]> {
  if (!value) return [];
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) return [registerRemoteFile(taskId, value)];
    if (isBase64Image(value)) return [await registerBase64File(taskId, value)];
    return [];
  }
  if (Array.isArray(value)) {
    const nested = await Promise.all(value.map((item) => normalizeFileValue(taskId, item)));
    return nested.flat();
  }
  if (isObject(value)) {
    const url =
      stringValue(value.url) ??
      stringValue(value.remote_url) ??
      stringValue(value.image_url) ??
      stringValue(value.download_url);
    const name = stringValue(value.name) ?? stringValue(value.filename);
    const mimeType = stringValue(value.mime_type) ?? stringValue(value.mimeType);
    if (url) return [registerRemoteFile(taskId, url, name, mimeType)];
  }
  return [];
}

function buildPayload(task: CharacterTask, promptText: string, jobId: string, responseMode: string) {
  return {
    inputs: {
      novel_name: task.input.novel_name,
      chapter_sort: task.input.chapter_sort,
      chapter_name: task.input.chapter_name,
      paragraph_content: task.input.paragraph_content,
      paragraph_image_url: task.input.paragraph_image_url,
      role_name: task.input.role_name,
      character_prompt: promptText
    },
    response_mode: responseMode,
    user: `character-job-${jobId}`
  };
}

function describeFetchFailure(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (isObject(cause)) {
    const code = stringValue(cause.code);
    const message = stringValue(cause.message);
    if (code && message) return `${error.message} (${code}: ${message})`;
    if (message) return `${error.message} (${message})`;
  }
  return error.message;
}

async function runBlocking(response: Response): Promise<DifyRunResult> {
  const payload = await response.json();
  return {
    workflowRunId: extractWorkflowRunId(payload),
    taskId: extractTaskId(payload),
    outputs: extractOutputs(payload),
    raw: payload
  };
}

async function runStreaming(response: Response): Promise<DifyRunResult> {
  if (!response.body) throw new Error('Dify streaming 响应没有 body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPayload: unknown;
  let outputs: Record<string, unknown> = {};
  let workflowRunId: string | undefined;
  let taskId: string | undefined;

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
      workflowRunId = extractWorkflowRunId(payload) ?? workflowRunId;
      taskId = extractTaskId(payload) ?? taskId;
      if (isObject(payload) && payload.event === 'workflow_finished') {
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
    }
  }

  return { workflowRunId, taskId, outputs, raw: lastPayload };
}

export async function runCharacterWorkflow(task: CharacterTask, promptText: string, jobId: string): Promise<DifyRunResult> {
  const apiKey = process.env.CHARACTER_DIFY_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 CHARACTER_DIFY_API_KEY，请检查 .env.local');
  }
  const responseMode = process.env.CHARACTER_DIFY_RESPONSE_MODE || 'blocking';
  let response: Response;
  try {
    response = await fetch(apiUrl('/workflows/run'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: responseMode === 'streaming' ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(buildPayload(task, promptText, jobId, responseMode))
    });
  } catch (error) {
    throw new Error(`角色形象提取请求失败：${describeFetchFailure(error)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`角色形象提取请求失败 ${response.status}${text ? `：${text}` : ''}`);
  }

  return responseMode === 'streaming' ? runStreaming(response) : runBlocking(response);
}

export async function applyCharacterDifyResult(task: CharacterTask, result: DifyRunResult) {
  const outputs = result.outputs ?? {};
  const portraitValues = [
    outputs.character_image,
    outputs.character_images,
    outputs.result,
    outputs.image,
    outputs.image_url,
    outputs.files
  ];
  const files = (await Promise.all(portraitValues.map((value) => normalizeFileValue(task.id, value)))).flat();
  if (files.length === 0) {
    throw new Error('未返回立绘图片');
  }
  task.workflow_run_id = result.workflowRunId;
  task.dify_task_id = result.taskId ?? task.dify_task_id;
  task.progress_percent = 100;
  task.progress_label = '已完成';
  task.extracted_role_name =
    stringValue(outputs.character_name) ??
    stringValue(outputs.role_name) ??
    (toStringArray(outputs.roles).join('、') || task.input.role_name);
  task.extracted_description = stringValue(outputs.description) ?? stringValue(outputs.result_text);
  task.portrait_files = files;
  task.result_text = stringValue(outputs.result_text) ?? stringValue(outputs.description);
  task.raw_outputs = outputs;
}

let runner = runCharacterWorkflow as CharacterRunWorkflow;

export function __setCharacterWorkflowControlsForTest(nextRunner?: CharacterRunWorkflow) {
  runner = nextRunner ?? runCharacterWorkflow;
}

export async function __runCharacterWorkflowForTest(task: CharacterTask, promptText: string, jobId: string) {
  return runner(task, promptText, jobId);
}
