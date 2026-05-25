import type express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ParsedWorkbook } from './types.js';

type ImageValue = '有价值' | '无价值';
type QualityRunStatus = 'idle' | 'running' | 'completed' | 'failed';

interface QualityPromptVersion {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  parentId?: string;
  calibrationSummary?: string;
  sampleCount?: number;
}

interface QualityJudgment {
  promptVersionId: string;
  status: QualityRunStatus;
  startedAt?: string;
  finishedAt?: string;
  elapsedSeconds?: number;
  workflowRunId?: string;
  taskId?: string;
  is_valid?: number;
  score?: number;
  image_value?: ImageValue;
  recommendation?: string;
  visual_elements: string[];
  non_visual_elements: string[];
  reason?: string;
  calibration_note?: string;
  judgment_report?: string;
  raw_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

interface QualityAnnotation {
  expectedImageValue: ImageValue;
  note?: string;
  updatedAt: string;
}

interface QualityRecord {
  id: string;
  row_no: number;
  paragraph_content: string;
  judgments: Record<string, QualityJudgment>;
  annotation?: QualityAnnotation;
}

interface QualityExperimentEvent {
  id: string;
  type: 'info' | 'error' | 'task' | 'calibration';
  message: string;
  createdAt: string;
  recordId?: string;
}

interface QualityExperiment {
  id: string;
  workbookId: string;
  sheetName: string;
  fileName: string;
  paragraphColumn: string;
  rowLimit?: number;
  promptVersionIds: string[];
  status: QualityRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  records: QualityRecord[];
  events: QualityExperimentEvent[];
}

interface QualityStore {
  activePromptVersionId: string;
  promptVersions: QualityPromptVersion[];
  experiments: QualityExperiment[];
}

interface DifyRunResult {
  workflowRunId?: string;
  taskId?: string;
  outputs: Record<string, unknown>;
  raw: unknown;
}

interface RegisterQualityOptions {
  getWorkbook: (workbookId: string) => ParsedWorkbook | undefined;
}

const STORE_PATH = path.resolve(process.cwd(), process.env.QUALITY_STORE_PATH ?? 'tmp/quality-store.json');
const SKILL_PROMPT_PATH =
  process.env.QUALITY_SKILL_PROMPT_PATH ??
  '/Users/staff/.codex/skills/novel-storyboard-value/references/production-prompt.md';

const DEFAULT_PROMPT = `角色设定
你是一位严苛的 AI 绘画视觉总监。你的核心职责是“去伪存真”：判断小说段落是否包含足够具体、可被图像模型渲染的视觉信息，能否生成一张有还原价值的分镜图。

核心原则
AI 绘图模型只能稳定画出“看得到的东西”：人物、外貌、姿态、表情、服饰、道具、武器、建筑、地形、天气、颜色、光影、材质、损毁状态、空间关系、正在发生的动作。
AI 绘图模型不能直接画出“听得到的口号”或“感受到的抽象气势”：命运、尊严、主宰、悲伤、压迫感、杀意、震撼、逆天、无敌、气势爆发、内心独白、关系解释、作者评价。
只有当抽象情绪或气势被转化为可见表现时，才算视觉元素。

任务
请评估输入的小说段落是否具备生成分镜图的价值，并输出严格 JSON。

输入段落
{{paragraph}}

判断流程
1. 先提取段落中真实存在的可见元素。
2. 再识别非视觉内容。
3. 只根据段落原文中的可见证据评分。
4. 判断它能否定格成一张静态分镜图。
5. 优先保证精确率。拿不准时判为“无价值”。

输出要求
只输出 JSON，不要输出 Markdown。

JSON 格式：
{
  "score": 1,
  "image_value": "有价值",
  "recommendation": "强烈推荐",
  "visual_elements": ["元素1"],
  "non_visual_elements": ["抽象内容1"],
  "reason": "一句话说明决定性原因",
  "calibration_note": ""
}`;

const subscribers = new Map<string, Set<(experiment: QualityExperiment) => void>>();
let storeCache: QualityStore | undefined;

function now() {
  return new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function asImageValue(value: unknown): ImageValue | undefined {
  return value === '有价值' || value === '无价值' ? value : undefined;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '无') return [];
    return trimmed
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function promptFromMarkdown(markdown: string) {
  const match = markdown.match(/```text\n([\s\S]*?)\n```/);
  return match?.[1]?.trim() || markdown.trim();
}

async function readSkillPrompt() {
  try {
    return promptFromMarkdown(await readFile(SKILL_PROMPT_PATH, 'utf8'));
  } catch {
    return DEFAULT_PROMPT;
  }
}

async function writeSkillPrompt(prompt: string) {
  const body = `# Production Prompt

Use this prompt in Dify or other external systems to judge whether a novel paragraph is valuable for storyboard image generation.

\`\`\`text
${prompt.trim()}
\`\`\`
`;
  await mkdir(path.dirname(SKILL_PROMPT_PATH), { recursive: true });
  await writeFile(SKILL_PROMPT_PATH, body, 'utf8');
}

async function createInitialStore(): Promise<QualityStore> {
  const prompt = await readSkillPrompt();
  const version: QualityPromptVersion = {
    id: nanoid(),
    name: 'v1 初始 Prompt',
    prompt,
    createdAt: now(),
    calibrationSummary: '从 novel-storyboard-value skill 的 production prompt 初始化'
  };
  return {
    activePromptVersionId: version.id,
    promptVersions: [version],
    experiments: []
  };
}

async function loadStore() {
  if (storeCache) return storeCache;
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    storeCache = JSON.parse(raw) as QualityStore;
    return storeCache;
  } catch {
    storeCache = await createInitialStore();
    await saveStore();
    return storeCache;
  }
}

async function saveStore() {
  if (!storeCache) return;
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(storeCache, null, 2)}\n`, 'utf8');
}

function summarizeExperiment(experiment: QualityExperiment) {
  const annotated = experiment.records.filter((record) => record.annotation).length;
  const activeJudged = experiment.records.filter((record) =>
    experiment.promptVersionIds.some((versionId) => record.judgments[versionId]?.status === 'completed')
  ).length;
  return {
    id: experiment.id,
    fileName: experiment.fileName,
    sheetName: experiment.sheetName,
    paragraphColumn: experiment.paragraphColumn,
    rowLimit: experiment.rowLimit,
    status: experiment.status,
    recordCount: experiment.records.length,
    judgedCount: activeJudged,
    annotatedCount: annotated,
    promptVersionIds: experiment.promptVersionIds,
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt
  };
}

function serializeStore(store: QualityStore) {
  return {
    activePromptVersionId: store.activePromptVersionId,
    promptVersions: store.promptVersions.map((version) => ({
      id: version.id,
      name: version.name,
      createdAt: version.createdAt,
      parentId: version.parentId,
      calibrationSummary: version.calibrationSummary,
      sampleCount: version.sampleCount,
      prompt: version.prompt
    })),
    experiments: store.experiments.map(summarizeExperiment)
  };
}

function addEvent(experiment: QualityExperiment, type: QualityExperimentEvent['type'], message: string, recordId?: string) {
  experiment.events.unshift({
    id: nanoid(),
    type,
    message,
    recordId,
    createdAt: now()
  });
  experiment.events = experiment.events.slice(0, 160);
}

function emit(experiment: QualityExperiment) {
  experiment.updatedAt = now();
  const listeners = subscribers.get(experiment.id);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(experiment);
  }
}

function subscribeExperiment(experimentId: string, listener: (experiment: QualityExperiment) => void) {
  let listeners = subscribers.get(experimentId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(experimentId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) subscribers.delete(experimentId);
  };
}

function getExperiment(store: QualityStore, experimentId: string) {
  return store.experiments.find((experiment) => experiment.id === experimentId);
}

function getPromptVersion(store: QualityStore, promptVersionId: string) {
  return store.promptVersions.find((version) => version.id === promptVersionId);
}

function filteredRows(workbook: ParsedWorkbook, sheetName: string, paragraphColumn: string, rowLimit?: number) {
  const sheet = workbook.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  if (!sheet.headers.includes(paragraphColumn)) throw new Error(`找不到段落内容列：${paragraphColumn}`);
  const rows = sheet.rows
    .filter((row) => String(row[paragraphColumn] ?? '').trim() !== '')
    .slice(0, rowLimit);
  return rows.map((row) => ({
    id: nanoid(),
    row_no: Number(row.__row_no ?? 0),
    paragraph_content: String(row[paragraphColumn] ?? '').trim(),
    judgments: {}
  }));
}

function apiUrl(pathname: string) {
  const base = process.env.QUALITY_DIFY_API_BASE ?? process.env.DIFY_API_BASE ?? 'http://dify.qmniu.com/v1';
  return `${base.replace(/\/$/, '')}${pathname}`;
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
      if (isObject(payload) && payload.event === 'error') {
        const data = isObject(payload.data) ? payload.data : {};
        throw new Error(asString(payload.message) ?? asString(data.error) ?? asString(data.message) ?? 'Dify streaming 返回错误');
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

async function runQualityWorkflow(
  paragraph: string,
  prompt: string,
  experimentId: string,
  rowNo: number
): Promise<DifyRunResult> {
  const apiKey = process.env.QUALITY_DIFY_API_KEY ?? process.env.DIFY_QUALITY_API_KEY;
  if (!apiKey) throw new Error('缺少 QUALITY_DIFY_API_KEY，请检查 .env.local');
  const responseMode = process.env.QUALITY_DIFY_RESPONSE_MODE || 'blocking';
  const response = await fetch(apiUrl('/workflows/run'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: responseMode === 'streaming' ? 'text/event-stream' : 'application/json'
    },
    body: JSON.stringify({
      inputs: {
        book_id: 0,
        paragraph_content: paragraph,
        chapter_sort: rowNo,
        quality_prompt: prompt
      },
      response_mode: responseMode,
      user: `quality-${experimentId}`
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Dify 质量判断请求失败 ${response.status}${text ? `：${text}` : ''}`);
  }

  return responseMode === 'streaming' ? runStreaming(response) : runBlocking(response);
}

function numberOutput(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function parseJudgmentOutputs(promptVersionId: string, result: DifyRunResult): QualityJudgment {
  const outputs = result.outputs;
  let report: Record<string, unknown> = {};
  const reportText = asString(outputs.judgment_report);
  if (reportText) {
    try {
      report = JSON.parse(reportText) as Record<string, unknown>;
    } catch {
      report = {};
    }
  }

  const score = numberOutput(outputs.score ?? report.score);
  const imageValue = asImageValue(outputs.image_value) ?? asImageValue(report.image_value);
  const isValidFromOutput = numberOutput(outputs.is_valid);
  const isValid = isValidFromOutput ?? (imageValue === '有价值' ? 1 : imageValue === '无价值' ? 0 : undefined);

  return {
    promptVersionId,
    status: 'completed',
    workflowRunId: result.workflowRunId,
    taskId: result.taskId,
    is_valid: isValid,
    score,
    image_value: imageValue,
    recommendation: asString(outputs.recommendation) ?? asString(report.recommendation),
    visual_elements: toStringArray(outputs.visual_elements ?? report.visual_elements),
    non_visual_elements: toStringArray(outputs.non_visual_elements ?? report.non_visual_elements),
    reason: asString(outputs.reason) ?? asString(report.reason),
    calibration_note: asString(outputs.calibration_note) ?? asString(report.calibration_note),
    judgment_report: reportText,
    raw_text: asString(outputs.raw_text) ?? asString(report.raw_text),
    raw_outputs: outputs
  };
}

async function runExperiment(experiment: QualityExperiment, promptVersionIds: string[]) {
  if (experiment.status === 'running') return;
  const store = await loadStore();
  experiment.status = 'running';
  experiment.startedAt = experiment.startedAt ?? now();
  experiment.finishedAt = undefined;
  addEvent(experiment, 'info', `开始质量判断：${promptVersionIds.length} 个 Prompt 版本，${experiment.records.length} 条段落`);
  emit(experiment);
  await saveStore();

  for (const promptVersionId of promptVersionIds) {
    const version = getPromptVersion(store, promptVersionId);
    if (!version) continue;
    for (const record of experiment.records) {
      const started = Date.now();
      record.judgments[promptVersionId] = {
        promptVersionId,
        status: 'running',
        startedAt: now(),
        visual_elements: [],
        non_visual_elements: []
      };
      addEvent(experiment, 'task', `第 ${record.row_no} 行开始判断：${version.name}`, record.id);
      emit(experiment);
      await saveStore();
      try {
        const result = await runQualityWorkflow(record.paragraph_content, version.prompt, experiment.id, record.row_no);
        record.judgments[promptVersionId] = {
          ...parseJudgmentOutputs(promptVersionId, result),
          startedAt: record.judgments[promptVersionId].startedAt,
          finishedAt: now(),
          elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1))
        };
        addEvent(experiment, 'task', `第 ${record.row_no} 行判断完成：${version.name}`, record.id);
      } catch (error) {
        record.judgments[promptVersionId] = {
          ...record.judgments[promptVersionId],
          status: 'failed',
          finishedAt: now(),
          elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          error: error instanceof Error ? error.message : '质量判断失败'
        };
        addEvent(experiment, 'error', `第 ${record.row_no} 行判断失败：${record.judgments[promptVersionId].error}`, record.id);
      }
      emit(experiment);
      await saveStore();
    }
  }

  experiment.status = experiment.records.some((record) =>
    promptVersionIds.some((versionId) => record.judgments[versionId]?.status === 'failed')
  )
    ? 'failed'
    : 'completed';
  experiment.finishedAt = now();
  addEvent(experiment, 'info', experiment.status === 'completed' ? '质量判断执行完成' : '质量判断执行完成，存在失败记录');
  emit(experiment);
  await saveStore();
}

function opposite(value: ImageValue): ImageValue {
  return value === '有价值' ? '无价值' : '有价值';
}

function truncateText(text: string, length = 180) {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function buildCalibrationSection(experiment: QualityExperiment, version: QualityPromptVersion) {
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];

  for (const record of experiment.records) {
    const expected = record.annotation?.expectedImageValue;
    const note = record.annotation?.note;
    const judgment = record.judgments[version.id];
    if (!expected || judgment?.status !== 'completed' || !judgment.image_value || expected === judgment.image_value) continue;
    const sample = `- 行 ${record.row_no}：原判 ${judgment.image_value}，人工标注 ${expected}。段落：“${truncateText(
      record.paragraph_content
    )}”。模型理由：${judgment.reason || '无'}${note ? `。人工备注：${note}` : ''}`;
    if (judgment.image_value === '有价值' && expected === '无价值') {
      falsePositives.push(sample);
    } else {
      falseNegatives.push(sample);
    }
  }

  if (falsePositives.length === 0 && falseNegatives.length === 0) {
    throw new Error('没有可用于校准的误判样本，请先标注与当前 Prompt 判断不一致的记录');
  }

  const lines = [
    '',
    `项目校准规则（${new Date().toLocaleString('zh-CN', { hour12: false })}）`,
    '以下人工校验样本优先级高于通用规则。判断新段落时，应从这些误判中抽象出更严格的边界，而不是记忆具体文本。',
    ''
  ];

  if (falsePositives.length > 0) {
    lines.push('误判为“有价值”但应为“无价值”的样本：');
    lines.push(...falsePositives.slice(0, 12));
    lines.push('校准要求：遇到同类段落时，只有抽象气势、台词、身份、情绪、剧情重要性，而缺少可见动作、环境、道具、状态或构图锚点，必须判为无价值。');
    lines.push('');
  }

  if (falseNegatives.length > 0) {
    lines.push('误判为“无价值”但应为“有价值”的样本：');
    lines.push(...falseNegatives.slice(0, 12));
    lines.push('校准要求：遇到同类段落时，即使文字简短，只要主体、动作、环境或关键视觉状态足以形成非泛化静态画面，可以判为有价值。');
    lines.push('');
  }

  return {
    section: lines.join('\n').trim(),
    sampleCount: falsePositives.length + falseNegatives.length,
    summary: `基于 ${falsePositives.length} 个误判有价值样本、${falseNegatives.length} 个误判无价值样本生成`
  };
}

function appendCalibrationPrompt(prompt: string, calibrationSection: string) {
  const trimmed = prompt.trim();
  const marker = '\n输出要求\n';
  if (trimmed.includes(marker)) {
    return trimmed.replace(marker, `\n${calibrationSection}\n${marker}`);
  }
  return `${trimmed}\n\n${calibrationSection}`;
}

function asyncHandler<TReq extends express.Request, TRes extends express.Response>(
  handler: (req: TReq, res: TRes) => Promise<void>
) {
  return (req: TReq, res: TRes, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requiredRouteParam(value: string | string[] | undefined, label: string) {
  const result = routeParam(value);
  if (!result) throw new Error(`缺少 ${label}`);
  return result;
}

function validPromptVersionIds(store: QualityStore, value: unknown, fallback: string[]) {
  const candidates = Array.isArray(value) ? value : fallback;
  return candidates.filter((item): item is string => typeof item === 'string' && Boolean(getPromptVersion(store, item)));
}

export function registerQualityRoutes(app: express.Express, options: RegisterQualityOptions) {
  app.get(
    '/api/quality/state',
    asyncHandler(async (_req, res) => {
      const store = await loadStore();
      res.json(serializeStore(store));
    })
  );

  app.get(
    '/api/quality/prompt-versions/:id',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const version = getPromptVersion(store, requiredRouteParam(req.params.id, 'Prompt 版本 ID'));
      if (!version) {
        res.status(404).json({ error: 'Prompt 版本不存在' });
        return;
      }
      res.json(version);
    })
  );

  app.post(
    '/api/quality/prompt-versions/:id/activate',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const version = getPromptVersion(store, requiredRouteParam(req.params.id, 'Prompt 版本 ID'));
      if (!version) {
        res.status(404).json({ error: 'Prompt 版本不存在' });
        return;
      }
      store.activePromptVersionId = version.id;
      await writeSkillPrompt(version.prompt);
      await saveStore();
      res.json(serializeStore(store));
    })
  );

  app.post(
    '/api/quality/experiments',
    asyncHandler(async (req, res) => {
      const { workbookId, sheetName, paragraphColumn } = req.body as {
        workbookId?: string;
        sheetName?: string;
        paragraphColumn?: string;
        rowLimit?: unknown;
        promptVersionIds?: unknown;
      };
      if (!workbookId || !sheetName || !paragraphColumn) {
        res.status(400).json({ error: '缺少 workbookId、sheetName 或 paragraphColumn' });
        return;
      }
      const workbook = options.getWorkbook(workbookId);
      if (!workbook) {
        res.status(404).json({ error: '工作簿不存在，请重新上传' });
        return;
      }

      let rowLimit: number | undefined;
      if (req.body.rowLimit !== undefined && req.body.rowLimit !== null && req.body.rowLimit !== '') {
        const parsed = Number(req.body.rowLimit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          res.status(400).json({ error: '测试行数必须是大于 0 的整数' });
          return;
        }
        rowLimit = parsed;
      }

      const store = await loadStore();
      const promptVersionIds = validPromptVersionIds(store, req.body.promptVersionIds, [store.activePromptVersionId]);
      const uniquePromptVersionIds = Array.from(new Set(promptVersionIds.length > 0 ? promptVersionIds : [store.activePromptVersionId]));

      const experiment: QualityExperiment = {
        id: nanoid(),
        workbookId,
        sheetName,
        fileName: workbook.fileName,
        paragraphColumn,
        rowLimit,
        promptVersionIds: uniquePromptVersionIds,
        status: 'idle',
        createdAt: now(),
        updatedAt: now(),
        records: filteredRows(workbook, sheetName, paragraphColumn, rowLimit),
        events: []
      };
      addEvent(experiment, 'info', `已创建质量判断测试，共 ${experiment.records.length} 条段落`);
      store.experiments.unshift(experiment);
      store.experiments = store.experiments.slice(0, 50);
      await saveStore();
      res.json(experiment);
    })
  );

  app.get(
    '/api/quality/experiments/:id',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const experiment = getExperiment(store, requiredRouteParam(req.params.id, '测试记录 ID'));
      if (!experiment) {
        res.status(404).json({ error: '测试记录不存在' });
        return;
      }
      res.json(experiment);
    })
  );

  app.get(
    '/api/quality/experiments/:id/events',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const experiment = getExperiment(store, requiredRouteParam(req.params.id, '测试记录 ID'));
      if (!experiment) {
        res.status(404).json({ error: '测试记录不存在' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`data: ${JSON.stringify(experiment)}\n\n`);
      const unsubscribe = subscribeExperiment(experiment.id, (nextExperiment) => {
        res.write(`data: ${JSON.stringify(nextExperiment)}\n\n`);
      });
      req.on('close', unsubscribe);
    })
  );

  app.post(
    '/api/quality/experiments/:id/run',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const experiment = getExperiment(store, requiredRouteParam(req.params.id, '测试记录 ID'));
      if (!experiment) {
        res.status(404).json({ error: '测试记录不存在' });
        return;
      }
      if (experiment.status === 'running') {
        res.status(409).json({ error: '质量判断正在执行中' });
        return;
      }
      const requestedIds = validPromptVersionIds(store, req.body?.promptVersionIds, experiment.promptVersionIds);
      const promptVersionIds = Array.from(new Set(requestedIds.length > 0 ? requestedIds : [store.activePromptVersionId]));
      experiment.promptVersionIds = Array.from(new Set([...experiment.promptVersionIds, ...promptVersionIds]));
      void runExperiment(experiment, promptVersionIds);
      res.json(experiment);
    })
  );

  app.post(
    '/api/quality/experiments/:experimentId/records/:recordId/annotation',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const experimentId = routeParam(req.params.experimentId);
      const recordId = routeParam(req.params.recordId);
      const experiment = experimentId ? getExperiment(store, experimentId) : undefined;
      const expected = asImageValue(req.body?.expectedImageValue);
      if (!experiment || !recordId) {
        res.status(404).json({ error: '测试记录不存在' });
        return;
      }
      if (!expected) {
        res.status(400).json({ error: 'expectedImageValue 只能是“有价值”或“无价值”' });
        return;
      }
      const record = experiment.records.find((item) => item.id === recordId);
      if (!record) {
        res.status(404).json({ error: '段落记录不存在' });
        return;
      }
      record.annotation = {
        expectedImageValue: expected,
        note: typeof req.body?.note === 'string' ? req.body.note.trim() : undefined,
        updatedAt: now()
      };
      addEvent(experiment, 'calibration', `第 ${record.row_no} 行标注为：${expected}`, record.id);
      emit(experiment);
      await saveStore();
      res.json(experiment);
    })
  );

  app.post(
    '/api/quality/experiments/:id/calibrate',
    asyncHandler(async (req, res) => {
      const store = await loadStore();
      const experiment = getExperiment(store, requiredRouteParam(req.params.id, '测试记录 ID'));
      if (!experiment) {
        res.status(404).json({ error: '测试记录不存在' });
        return;
      }
      const basePromptVersionId =
        typeof req.body?.promptVersionId === 'string' ? req.body.promptVersionId : store.activePromptVersionId;
      const baseVersion = getPromptVersion(store, basePromptVersionId);
      if (!baseVersion) {
        res.status(404).json({ error: 'Prompt 版本不存在' });
        return;
      }

      const calibration = buildCalibrationSection(experiment, baseVersion);
      const nextVersion: QualityPromptVersion = {
        id: nanoid(),
        name: `v${store.promptVersions.length + 1} 校准 Prompt`,
        prompt: appendCalibrationPrompt(baseVersion.prompt, calibration.section),
        createdAt: now(),
        parentId: baseVersion.id,
        calibrationSummary: calibration.summary,
        sampleCount: calibration.sampleCount
      };
      store.promptVersions.unshift(nextVersion);
      store.activePromptVersionId = nextVersion.id;
      experiment.promptVersionIds = Array.from(new Set([nextVersion.id, ...experiment.promptVersionIds]));
      addEvent(experiment, 'calibration', `已生成并启用 ${nextVersion.name}：${calibration.summary}`);
      emit(experiment);
      await writeSkillPrompt(nextVersion.prompt);
      await saveStore();
      res.json({
        promptVersion: nextVersion,
        state: serializeStore(store),
        experiment
      });
    })
  );
}

export const __qualityTestables = {
  appendCalibrationPrompt,
  promptFromMarkdown,
  toStringArray,
  opposite
};
