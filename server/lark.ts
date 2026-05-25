import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Batch, LarkExportResult } from './types.js';
import { ensureLocalFile } from './fileStore.js';

interface CliResult {
  stdout: string;
  stderr: string;
  json?: unknown;
}

interface RunLarkOptions {
  cwd?: string;
}

function asIdentityArg() {
  const value = process.env.LARK_CLI_AS || 'user';
  return ['--as', value];
}

function runLark(args: string[], options: RunLarkOptions = {}): Promise<CliResult> {
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

async function createTable(baseToken: string, tableName: string) {
  const result = await runLark([
    'base',
    '+table-create',
    ...asIdentityArg(),
    '--base-token',
    baseToken,
    '--name',
    tableName,
    '--fields',
    JSON.stringify(TABLE_FIELDS),
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

async function uploadAttachments(baseToken: string, tableId: string, batch: Batch, recordIds: string[]) {
  let uploaded = 0;
  for (let index = 0; index < batch.tasks.length; index += 1) {
    const task = batch.tasks[index];
    const recordId = recordIds[index];
    if (!recordId || task.result_files.length === 0) continue;
    for (const file of task.result_files) {
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
        '结果图片',
        '--file',
        relativeCliPath(filePath)
      ], { cwd: fileDir });
      uploaded += 1;
    }
  }
  return uploaded;
}

export async function exportBatchToLark(batch: Batch): Promise<LarkExportResult> {
  const baseName = `Dify 批量结果 ${larkDate()}`;
  const tableName = '批量结果';
  const { baseToken, baseUrl } = await createBase(baseName);
  const tableId = await createTable(baseToken, tableName);
  const recordIds = await batchCreateRecords(baseToken, tableId, batch);
  const attachmentsUploaded = await uploadAttachments(baseToken, tableId, batch, recordIds);

  return {
    baseToken,
    baseUrl,
    tableId,
    tableName,
    createdAt: new Date().toISOString(),
    recordsCreated: recordIds.length,
    attachmentsUploaded
  };
}
