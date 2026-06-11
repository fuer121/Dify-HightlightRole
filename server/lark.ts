import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Batch, CharacterJob, CharacterTask, LarkExportResult, ResultFile, RoleAsset, RoleAssetStatus } from './types.js';
import { ensureLocalFile, registerBase64File, registerRemoteFile } from './fileStore.js';

interface CliResult {
  stdout: string;
  stderr: string;
  json?: unknown;
}

interface RunLarkOptions {
  cwd?: string;
}

export type LarkCliRunner = (args: string[], options?: RunLarkOptions) => Promise<CliResult>;

interface AttachmentUploadSummary {
  uploaded: number;
  failed: number;
}

interface WorkflowExportColumn {
  workflowId: string;
  workflowName: string;
  fieldName: string;
}

function asIdentityArg() {
  const value = process.env.LARK_CLI_AS || 'user';
  return ['--as', value];
}

function defaultRunLark(args: string[], options: RunLarkOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(new Error(`无法运行 lark-cli：${error.message}`));
    });
    child.on('close', (code) => {
      const parsed = parseJson(stdout);
      if (code === 0) {
        resolve({ stdout, stderr, json: parsed });
        return;
      }
      reject(new Error(formatCliError(code, stdout, stderr)));
    });
  });
}

let larkCliRunner: LarkCliRunner = defaultRunLark;

function readLarkCliRetries() {
  const value = Number(process.env.LARK_CLI_RETRIES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}

function readLarkCliRetryDelayMs() {
  const value = Number(process.env.LARK_CLI_RETRY_DELAY_MS ?? 1500);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1500;
}

function readLarkAttachmentConcurrency() {
  const value = Number(process.env.LARK_ATTACHMENT_CONCURRENCY ?? 4);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 4;
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        await worker(item);
      }
    })
  );
}

function isRetryableLarkCliError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /network|timeout|TLS handshake timeout|i\/o timeout|connection reset|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporarily unavailable/i.test(
    message
  );
}

async function runLark(args: string[], options: RunLarkOptions = {}): Promise<CliResult> {
  const retries = readLarkCliRetries();
  const retryDelayMs = readLarkCliRetryDelayMs();
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await larkCliRunner(args, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableLarkCliError(error)) throw error;
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

export function __setLarkCliRunnerForTest(runner?: LarkCliRunner) {
  larkCliRunner = runner ?? defaultRunLark;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart >= 0) {
      try {
        return JSON.parse(trimmed.slice(jsonStart));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function formatCliError(code: number | null, stdout: string, stderr: string) {
  const body = stderr.trim() || stdout.trim();
  return `lark-cli 失败（exit ${code ?? 'unknown'}）${body ? `：${body}` : ''}`;
}

function findDeep(value: unknown, predicate: (key: string, value: unknown) => boolean): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, predicate);
      if (found !== undefined) return found;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (predicate(key, child)) return child;
      const found = findDeep(child, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function extractBaseInfo(json: unknown) {
  const token = findDeep(json, (key, value) => typeof value === 'string' && ['token', 'base_token', 'app_token'].includes(key));
  const url = findDeep(json, (key, value) => typeof value === 'string' && key === 'url');
  return {
    baseToken: typeof token === 'string' ? token : undefined,
    baseUrl: typeof url === 'string' ? url : undefined
  };
}

function extractTableId(json: unknown) {
  const id = findDeep(
    json,
    (key, value) => typeof value === 'string' && (key === 'table_id' || key === 'id') && value.startsWith('tbl')
  );
  return typeof id === 'string' ? id : undefined;
}

function extractRecordIds(json: unknown) {
  const recordIdList = findDeep(
    json,
    (key, value) => key === 'record_id_list' && Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
  if (Array.isArray(recordIdList)) return recordIdList as string[];

  const ids: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'record_id' || key === 'id') && typeof child === 'string' && child.startsWith('rec')) {
        ids.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(json);
  return Array.from(new Set(ids));
}

function larkDate() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

function relativeCliPath(filePath: string) {
  return `./${path.basename(filePath)}`;
}

const FIELDS = [
  '行号',
  '状态',
  '书籍 ID',
  '章节序号',
  '段落内容',
  'is_valid',
  '段落描述',
  '角色',
  '标题',
  '结果文本/JSON',
  'workflow_run_id',
  '耗时',
  '错误'
];

const TABLE_FIELDS = [
  { name: '行号', type: 'number', style: { type: 'plain', precision: 0 } },
  {
    name: '状态',
    type: 'select',
    multiple: false,
    options: [
      { name: 'queued', hue: 'Blue', lightness: 'Lighter' },
      { name: 'running', hue: 'Orange', lightness: 'Light' },
      { name: 'succeeded', hue: 'Green', lightness: 'Light' },
      { name: 'failed', hue: 'Red', lightness: 'Light' },
      { name: 'paused', hue: 'Gray', lightness: 'Light' }
    ]
  },
  { name: '书籍 ID', type: 'number', style: { type: 'plain', precision: 0 } },
  { name: '章节序号', type: 'number', style: { type: 'plain', precision: 0 } },
  { name: '段落内容', type: 'text' },
  { name: 'is_valid', type: 'text' },
  { name: '段落描述', type: 'text' },
  { name: '角色', type: 'text' },
  { name: '标题', type: 'text' },
  { name: '结果图片', type: 'attachment' },
  { name: '结果文本/JSON', type: 'text' },
  { name: 'workflow_run_id', type: 'text' },
  { name: '耗时', type: 'number', style: { type: 'plain', precision: 1 } },
  { name: '错误', type: 'text' }
];

const CHARACTER_FIELDS = [
  '行号',
  '状态',
  '小说名',
  '章节序号',
  '章节名',
  '角色名',
  '段落内容',
  '角色描述',
  '结果文本',
  'workflow_run_id',
  'dify_task_id',
  '耗时',
  '错误'
];

const CHARACTER_TABLE_FIELDS = [
  { name: '行号', type: 'number', style: { type: 'plain', precision: 0 } },
  {
    name: '状态',
    type: 'select',
    multiple: false,
    options: [
      { name: 'queued', hue: 'Blue', lightness: 'Lighter' },
      { name: 'running', hue: 'Orange', lightness: 'Light' },
      { name: 'succeeded', hue: 'Green', lightness: 'Light' },
      { name: 'failed', hue: 'Red', lightness: 'Light' },
      { name: 'paused', hue: 'Gray', lightness: 'Light' }
    ]
  },
  { name: '小说名', type: 'text' },
  { name: '章节序号', type: 'number', style: { type: 'plain', precision: 0 } },
  { name: '章节名', type: 'text' },
  { name: '角色名', type: 'text' },
  { name: '段落内容', type: 'text' },
  { name: '原段落图片', type: 'attachment' },
  { name: '生成立绘', type: 'attachment' },
  { name: '角色描述', type: 'text' },
  { name: '结果文本', type: 'text' },
  { name: 'workflow_run_id', type: 'text' },
  { name: 'dify_task_id', type: 'text' },
  { name: '耗时', type: 'number', style: { type: 'plain', precision: 1 } },
  { name: '错误', type: 'text' }
];

const ROLE_ASSET_FIELDS = ['小说名称', '实际提取的角色名称', '启用状态'];

const ROLE_ASSET_TABLE_FIELDS = [
  { name: '小说名称', type: 'text' },
  { name: '角色立绘图', type: 'attachment' },
  { name: '实际提取的角色名称', type: 'text' },
  {
    name: '启用状态',
    type: 'select',
    multiple: false,
    options: [
      { name: '待确认', hue: 'Blue', lightness: 'Lighter' },
      { name: '已启用', hue: 'Green', lightness: 'Light' },
      { name: '已禁用', hue: 'Gray', lightness: 'Light' }
    ]
  }
];

const ROLE_ASSET_STATUS_LABEL: Record<RoleAssetStatus, string> = {
  draft: '待确认',
  active: '已启用',
  disabled: '已禁用'
};

function formatRawValue(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function taskToRow(task: Batch['tasks'][number]) {
  const raw = task.raw_outputs ? JSON.stringify(task.raw_outputs, null, 2) : '';
  return [
    task.row_no,
    task.status,
    task.input.book_id,
    task.input.chapter_sort,
    task.input.paragraph_content,
    formatRawValue(task.is_valid),
    task.paragraph_description ?? '',
    task.role?.join(', ') ?? '',
    task.title ?? '',
    task.result_text ?? raw,
    task.workflow_run_id ?? '',
    task.elapsed_seconds ?? null,
    task.error ?? ''
  ];
}

function characterTaskToRow(task: CharacterTask) {
  const raw = task.raw_outputs ? JSON.stringify(task.raw_outputs, null, 2) : '';
  return [
    task.row_no,
    task.status,
    task.input.novel_name,
    task.input.chapter_sort,
    task.input.chapter_name,
    task.extracted_role_name || task.input.role_name,
    task.input.paragraph_content,
    task.extracted_description ?? '',
    task.result_text ?? raw,
    task.workflow_run_id ?? '',
    task.dify_task_id ?? '',
    task.elapsed_seconds ?? null,
    task.error ?? ''
  ];
}

function roleAssetToRow(asset: RoleAsset) {
  return [asset.novel_name || String(asset.book_id), asset.role_name, ROLE_ASSET_STATUS_LABEL[asset.status]];
}

function roleAssetPortraitFile(asset: RoleAsset) {
  if (asset.image_file) return asset.image_file;
  if (!asset.image_url) return undefined;
  return registerRemoteFile(asset.id, asset.image_url, `${asset.role_name}.png`);
}

function workflowExportColumns(batch: Batch): WorkflowExportColumn[] {
  const orderedWorkflowIds = ['primary', 'compare'];
  const results = batch.tasks.flatMap((task) => task.workflow_results ?? []);
  const selected = [
    ...orderedWorkflowIds
      .map((workflowId) => results.find((result) => result.workflow_id === workflowId))
      .filter((result): result is NonNullable<typeof result> => Boolean(result)),
    ...results.filter((result) => !orderedWorkflowIds.includes(result.workflow_id))
  ];
  const usedWorkflowIds = new Set<string>();
  const usedFieldNames = new Set<string>(TABLE_FIELDS.map((field) => field.name));
  const columns: WorkflowExportColumn[] = [];

  for (const result of selected) {
    if (usedWorkflowIds.has(result.workflow_id)) continue;
    usedWorkflowIds.add(result.workflow_id);
    const baseName = result.workflow_name.trim() || result.workflow_id;
    let fieldName = baseName;
    let suffix = 2;
    while (usedFieldNames.has(fieldName)) {
      fieldName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    usedFieldNames.add(fieldName);
    columns.push({
      workflowId: result.workflow_id,
      workflowName: result.workflow_name,
      fieldName
    });
  }

  return columns;
}

function batchTableFields(batch: Batch) {
  const workflowFields = workflowExportColumns(batch).map((column) => ({ name: column.fieldName, type: 'attachment' }));
  if (workflowFields.length === 0) return TABLE_FIELDS;
  const resultImageIndex = TABLE_FIELDS.findIndex((field) => field.name === '结果图片');
  if (resultImageIndex < 0) return [...TABLE_FIELDS, ...workflowFields];
  return [...TABLE_FIELDS.slice(0, resultImageIndex + 1), ...workflowFields, ...TABLE_FIELDS.slice(resultImageIndex + 1)];
}

async function createBase(name: string) {
  const result = await runLark(['base', '+base-create', ...asIdentityArg(), '--name', name, '--time-zone', 'Asia/Shanghai']);
  const info = extractBaseInfo(result.json);
  if (!info.baseToken) {
    throw new Error(`飞书 Base 创建成功但没有解析到 token：${result.stdout}`);
  }
  return {
    baseToken: info.baseToken,
    baseUrl: info.baseUrl
  };
}

async function createTable(baseToken: string, tableName: string, batch: Batch) {
  return createTableWithFields(baseToken, tableName, batchTableFields(batch));
}

async function createTableWithFields(baseToken: string, tableName: string, fields: unknown[]) {
  const result = await runLark([
    'base',
    '+table-create',
    ...asIdentityArg(),
    '--base-token',
    baseToken,
    '--name',
    tableName,
    '--fields',
    JSON.stringify(fields),
    '--view',
    JSON.stringify([{ name: '默认表格', type: 'grid' }])
  ]);
  const tableId = extractTableId(result.json);
  if (!tableId) {
    throw new Error(`飞书数据表创建成功但没有解析到 table_id：${result.stdout}`);
  }
  return tableId;
}

async function batchCreateRecords(baseToken: string, tableId: string, batch: Batch) {
  const rows = batch.tasks.map(taskToRow);
  if (rows.length === 0) return [];

  const tempDir = path.resolve(process.cwd(), 'tmp', 'lark-export');
  await mkdir(tempDir, { recursive: true });

  const recordIds: string[] = [];
  for (let index = 0; index < rows.length; index += 200) {
    const filePath = path.join(tempDir, `records-${batch.id}-${index}-${nanoid(6)}.json`);
    const payload = {
      fields: FIELDS,
      rows: rows.slice(index, index + 200)
    };
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
    const fileDir = path.dirname(filePath);
    const result = await runLark([
      'base',
      '+record-batch-create',
      ...asIdentityArg(),
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--json',
      `@${relativeCliPath(filePath)}`
    ], { cwd: fileDir });
    recordIds.push(...extractRecordIds(result.json));
  }
  return recordIds;
}

async function characterBatchCreateRecords(baseToken: string, tableId: string, jobId: string, tasks: CharacterTask[]) {
  const rows = tasks.map(characterTaskToRow);
  if (rows.length === 0) return [];

  const tempDir = path.resolve(process.cwd(), 'tmp', 'lark-export');
  await mkdir(tempDir, { recursive: true });

  const recordIds: string[] = [];
  for (let index = 0; index < rows.length; index += 200) {
    const filePath = path.join(tempDir, `character-records-${jobId}-${index}-${nanoid(6)}.json`);
    const payload = {
      fields: CHARACTER_FIELDS,
      rows: rows.slice(index, index + 200)
    };
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
    const fileDir = path.dirname(filePath);
    const result = await runLark([
      'base',
      '+record-batch-create',
      ...asIdentityArg(),
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--json',
      `@${relativeCliPath(filePath)}`
    ], { cwd: fileDir });
    recordIds.push(...extractRecordIds(result.json));
  }
  return recordIds;
}

async function roleAssetBatchCreateRecords(baseToken: string, tableId: string, assets: RoleAsset[]) {
  const rows = assets.map(roleAssetToRow);
  if (rows.length === 0) return [];

  const tempDir = path.resolve(process.cwd(), 'tmp', 'lark-export');
  await mkdir(tempDir, { recursive: true });

  const recordIds: string[] = [];
  for (let index = 0; index < rows.length; index += 200) {
    const filePath = path.join(tempDir, `role-asset-records-${index}-${nanoid(6)}.json`);
    const payload = {
      fields: ROLE_ASSET_FIELDS,
      rows: rows.slice(index, index + 200)
    };
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
    const fileDir = path.dirname(filePath);
    const result = await runLark(
      [
        'base',
        '+record-batch-create',
        ...asIdentityArg(),
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--json',
        `@${relativeCliPath(filePath)}`
      ],
      { cwd: fileDir }
    );
    recordIds.push(...extractRecordIds(result.json));
  }
  return recordIds;
}

async function uploadRoleAssetAttachments(baseToken: string, tableId: string, assets: RoleAsset[], recordIds: string[]) {
  const summary: AttachmentUploadSummary = { uploaded: 0, failed: 0 };
  const jobs: Array<{ recordId: string; file: ResultFile }> = [];
  for (let index = 0; index < assets.length; index += 1) {
    const recordId = recordIds[index];
    if (!recordId) continue;
    const portraitFile = roleAssetPortraitFile(assets[index]);
    if (!portraitFile) continue;
    jobs.push({ recordId, file: portraitFile });
  }

  await forEachWithConcurrency(jobs, readLarkAttachmentConcurrency(), async ({ recordId, file }) => {
    if (await uploadFileAttachmentSafely(baseToken, tableId, recordId, '角色立绘图', file)) {
      summary.uploaded += 1;
    } else {
      summary.failed += 1;
    }
  });
  return summary;
}

async function uploadAttachments(baseToken: string, tableId: string, batch: Batch, recordIds: string[]) {
  const summary: AttachmentUploadSummary = { uploaded: 0, failed: 0 };
  const workflowColumns = workflowExportColumns(batch);
  for (let index = 0; index < batch.tasks.length; index += 1) {
    const task = batch.tasks[index];
    const recordId = recordIds[index];
    if (!recordId) continue;
    for (const file of task.result_files) {
      if (await uploadFileAttachmentSafely(baseToken, tableId, recordId, '结果图片', file)) {
        summary.uploaded += 1;
      } else {
        summary.failed += 1;
      }
    }
    for (const result of task.workflow_results ?? []) {
      const column =
        workflowColumns.find((item) => item.workflowId === result.workflow_id && item.workflowName === result.workflow_name) ??
        workflowColumns.find((item) => item.workflowId === result.workflow_id);
      if (!column) continue;
      for (const file of result.result_files) {
        if (await uploadFileAttachmentSafely(baseToken, tableId, recordId, column.fieldName, file)) {
          summary.uploaded += 1;
        } else {
          summary.failed += 1;
        }
      }
    }
  }
  return summary;
}

async function uploadFileAttachment(baseToken: string, tableId: string, recordId: string, fieldName: string, file: ResultFile) {
  const filePath = await ensureLocalFile(file);
  const fileDir = path.dirname(filePath);
  await runLark([
    'base',
    '+record-upload-attachment',
    ...asIdentityArg(),
    '--base-token',
    baseToken,
    '--table-id',
    tableId,
    '--record-id',
    recordId,
    '--field-id',
    fieldName,
    '--file',
    relativeCliPath(filePath)
  ], { cwd: fileDir });
}

async function uploadFileAttachmentSafely(baseToken: string, tableId: string, recordId: string, fieldName: string, file: ResultFile) {
  try {
    await uploadFileAttachment(baseToken, tableId, recordId, fieldName, file);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[lark-export] 附件上传失败，已跳过：field=${fieldName} record=${recordId} file=${file.name} error=${message}`);
    return false;
  }
}

async function registerParagraphImage(task: CharacterTask) {
  const url = task.input.paragraph_image_url.trim();
  if (!url) return undefined;
  if (/^data:image\/[^;]+;base64,/.test(url)) {
    return registerBase64File(task.id, url, `source-${task.row_no}.png`);
  }
  return registerRemoteFile(task.id, url, `source-${task.row_no}${path.extname(new URL(url).pathname) || '.png'}`);
}

async function uploadCharacterAttachments(baseToken: string, tableId: string, tasks: CharacterTask[], recordIds: string[]) {
  const summary: AttachmentUploadSummary = { uploaded: 0, failed: 0 };
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const recordId = recordIds[index];
    if (!recordId) continue;

    for (const file of task.portrait_files) {
      if (await uploadFileAttachmentSafely(baseToken, tableId, recordId, '生成立绘', file)) {
        summary.uploaded += 1;
      } else {
        summary.failed += 1;
      }
    }

    const paragraphImage = await registerParagraphImage(task);
    if (paragraphImage) {
      if (await uploadFileAttachmentSafely(baseToken, tableId, recordId, '原段落图片', paragraphImage)) {
        summary.uploaded += 1;
      } else {
        summary.failed += 1;
      }
    }
  }
  return summary;
}

export async function exportBatchToLark(batch: Batch): Promise<LarkExportResult> {
  const baseName = `Dify 批量结果 ${larkDate()}`;
  const tableName = '批量结果';
  const { baseToken, baseUrl } = await createBase(baseName);
  const tableId = await createTable(baseToken, tableName, batch);
  const recordIds = await batchCreateRecords(baseToken, tableId, batch);
  const attachments = await uploadAttachments(baseToken, tableId, batch, recordIds);

  return {
    baseToken,
    baseUrl,
    tableId,
    tableName,
    createdAt: new Date().toISOString(),
    recordsCreated: recordIds.length,
    attachmentsUploaded: attachments.uploaded,
    attachmentsFailed: attachments.failed
  };
}

export async function exportCharacterJobToLark(job: CharacterJob, taskIds: string[]): Promise<LarkExportResult> {
  const requestedIds = Array.from(new Set(taskIds));
  if (requestedIds.length === 0) throw new Error('导出范围不能为空');

  const jobTaskIds = new Set(job.tasks.map((task) => task.id));
  if (requestedIds.some((taskId) => !jobTaskIds.has(taskId))) {
    throw new Error('导出范围包含不存在的角色任务');
  }

  const requestedIdSet = new Set(requestedIds);
  const tasks = job.tasks.filter((task) => requestedIdSet.has(task.id));
  const baseName = `角色形象提取 ${job.fileName} ${larkDate()}`;
  const tableName = '角色立绘结果';
  const { baseToken, baseUrl } = await createBase(baseName);
  const tableId = await createTableWithFields(baseToken, tableName, CHARACTER_TABLE_FIELDS);
  const recordIds = await characterBatchCreateRecords(baseToken, tableId, job.id, tasks);
  const attachments = await uploadCharacterAttachments(baseToken, tableId, tasks, recordIds);

  return {
    baseToken,
    baseUrl,
    tableId,
    tableName,
    createdAt: new Date().toISOString(),
    recordsCreated: recordIds.length,
    attachmentsUploaded: attachments.uploaded,
    attachmentsFailed: attachments.failed
  };
}

export async function exportRoleAssetsToLark(assets: RoleAsset[]): Promise<LarkExportResult> {
  if (assets.length === 0) throw new Error('导出范围不能为空');

  const baseName = `角色底图导出 ${larkDate()}`;
  const tableName = '角色底图';
  const { baseToken, baseUrl } = await createBase(baseName);
  const tableId = await createTableWithFields(baseToken, tableName, ROLE_ASSET_TABLE_FIELDS);
  const recordIds = await roleAssetBatchCreateRecords(baseToken, tableId, assets);
  const attachments = await uploadRoleAssetAttachments(baseToken, tableId, assets, recordIds);

  return {
    baseToken,
    baseUrl,
    tableId,
    tableName,
    createdAt: new Date().toISOString(),
    recordsCreated: recordIds.length,
    attachmentsUploaded: attachments.uploaded,
    attachmentsFailed: attachments.failed
  };
}
