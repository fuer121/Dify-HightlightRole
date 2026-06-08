import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { nanoid } from 'nanoid';
import type {
  Batch,
  BatchLogEvent,
  BatchTask,
  BookBatchSummary,
  BookDetail,
  BookSummary,
  ResultFile,
  TaskRunRecord,
  TaskStatus
} from './types.js';
import { registerStoredFile } from './fileStore.js';

type SqlRow = Record<string, unknown>;

let db: DatabaseSync | null = null;
let currentStorePath = '';

function now() {
  return new Date().toISOString();
}

function storePath() {
  if (process.env.BATCH_STORE_PATH) return path.resolve(process.cwd(), process.env.BATCH_STORE_PATH);
  if (process.env.NODE_ENV === 'test') return ':memory:';
  return path.resolve(process.cwd(), 'data/dify-batch.sqlite');
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolNumber(value: boolean) {
  return value ? 1 : 0;
}

export function getDb() {
  const nextPath = storePath();
  if (!db || currentStorePath !== nextPath) {
    if (nextPath !== ':memory:') {
      fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    }
    db?.close();
    db = new DatabaseSync(nextPath);
    currentStorePath = nextPath;
    initializeStore();
  }
  return db;
}

export function closeStoreForTest() {
  db?.close();
  db = null;
  currentStorePath = '';
}

function withTransaction(work: () => void) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    work();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function columnExists(table: string, column: string) {
  const row = getDb()
    .prepare(`SELECT 1 AS present FROM pragma_table_info('${table}') WHERE name = ? LIMIT 1`)
    .get(column) as SqlRow | undefined;
  return row?.present === 1;
}

export function initializeStore() {
  const database = db ?? getDb();
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS books (
      book_id REAL PRIMARY KEY,
      name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      workbook_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      row_limit INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      pause_requested INTEGER NOT NULL DEFAULT 0,
      export_json TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      row_no INTEGER NOT NULL,
      book_id REAL NOT NULL,
      paragraph_content TEXT NOT NULL,
      chapter_sort REAL NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      elapsed_seconds REAL,
      workflow_run_id TEXT,
      dify_task_id TEXT,
      progress_percent REAL,
      progress_label TEXT,
      pause_reason TEXT,
      stop_requested_at TEXT,
      is_valid_json TEXT,
      paragraph_description TEXT,
      role_json TEXT,
      title TEXT,
      result_files_json TEXT NOT NULL DEFAULT '[]',
      result_text TEXT,
      raw_outputs_json TEXT,
      error TEXT,
      source_kind TEXT NOT NULL DEFAULT 'batch',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(book_id) ON UPDATE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS batch_tasks (
      batch_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      row_no INTEGER NOT NULL,
      PRIMARY KEY (batch_id, task_id),
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      elapsed_seconds REAL,
      workflow_run_id TEXT,
      dify_task_id TEXT,
      is_valid_json TEXT,
      result_files_json TEXT NOT NULL DEFAULT '[]',
      result_text TEXT,
      raw_outputs_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS batch_events (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      task_id TEXT,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_book ON tasks(book_id, deleted_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id, deleted_at, row_no);
    CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch ON batch_tasks(batch_id, row_no);
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_batch_events_batch ON batch_events(batch_id, created_at DESC);
  `);
  database.exec(`
    UPDATE tasks
    SET status = 'paused',
        progress_percent = 0,
        progress_label = '服务重启后已暂停，可继续',
        pause_reason = 'stop',
        stop_requested_at = NULL,
        updated_at = datetime('now')
    WHERE status = 'running';

    UPDATE batches
    SET status = 'paused',
        pause_requested = 1,
        updated_at = datetime('now')
    WHERE status = 'running';
  `);
  if (!columnExists('task_runs', 'is_valid_json')) {
    database.exec('ALTER TABLE task_runs ADD COLUMN is_valid_json TEXT');
  }
}

function upsertBook(bookId: number, name?: string) {
  const timestamp = now();
  getDb()
    .prepare(
      `
      INSERT INTO books (book_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        name = COALESCE(excluded.name, books.name),
        updated_at = excluded.updated_at
    `
    )
    .run(bookId, name ?? null, timestamp, timestamp);
}

export function updateBookName(bookId: number, name: string) {
  const timestamp = now();
  upsertBook(bookId);
  getDb()
    .prepare(
      `
      UPDATE books
      SET name = ?, updated_at = ?
      WHERE book_id = ?
    `
    )
    .run(name.trim() || null, timestamp, bookId);
  return getBook(bookId);
}

export function saveBatch(batch: Batch) {
  const database = getDb();
  const timestamp = now();
  withTransaction(() => {
    database
      .prepare(
        `
        INSERT INTO batches (
          id, workbook_id, sheet_name, file_name, mapping_json, row_limit, status,
          created_at, updated_at, started_at, finished_at, pause_requested, export_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workbook_id = excluded.workbook_id,
          sheet_name = excluded.sheet_name,
          file_name = excluded.file_name,
          mapping_json = excluded.mapping_json,
          row_limit = excluded.row_limit,
          status = excluded.status,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          pause_requested = excluded.pause_requested,
          export_json = excluded.export_json
      `
      )
      .run(
        batch.id,
        batch.workbookId,
        batch.sheetName,
        batch.fileName,
        json(batch.mapping),
        batch.rowLimit ?? null,
        batch.status,
        batch.createdAt,
        batch.updatedAt,
        batch.startedAt ?? null,
        batch.finishedAt ?? null,
        boolNumber(batch.pauseRequested),
        batch.export ? json(batch.export) : null
      );

    for (const task of batch.tasks) {
      saveTaskRow(task, batch.id, 'batch', timestamp);
      database
        .prepare(
          `
          INSERT OR REPLACE INTO batch_tasks (batch_id, task_id, row_no)
          VALUES (?, ?, ?)
        `
        )
        .run(batch.id, task.id, task.row_no);
    }

    for (const event of batch.events) {
      saveEventRow(batch.id, event);
    }
  });
}

export function updateBatchFileName(batchId: string, fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) throw new Error('任务清单名称不能为空');
  const timestamp = now();
  const result = getDb()
    .prepare(
      `
      UPDATE batches
      SET file_name = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(trimmed, timestamp, batchId);
  return result.changes > 0;
}

function saveTaskRow(task: BatchTask, batchId: string | null, sourceKind: string, timestamp = now()) {
  upsertBook(task.input.book_id);
  getDb()
    .prepare(
      `
      INSERT INTO tasks (
        id, batch_id, row_no, book_id, paragraph_content, chapter_sort, status, attempts,
        started_at, finished_at, elapsed_seconds, workflow_run_id, dify_task_id, progress_percent,
        progress_label, pause_reason, stop_requested_at, is_valid_json, paragraph_description,
        role_json, title, result_files_json, result_text, raw_outputs_json, error, source_kind,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        batch_id = COALESCE(tasks.batch_id, excluded.batch_id),
        row_no = excluded.row_no,
        book_id = excluded.book_id,
        paragraph_content = excluded.paragraph_content,
        chapter_sort = excluded.chapter_sort,
        status = excluded.status,
        attempts = excluded.attempts,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        elapsed_seconds = excluded.elapsed_seconds,
        workflow_run_id = excluded.workflow_run_id,
        dify_task_id = excluded.dify_task_id,
        progress_percent = excluded.progress_percent,
        progress_label = excluded.progress_label,
        pause_reason = excluded.pause_reason,
        stop_requested_at = excluded.stop_requested_at,
        is_valid_json = excluded.is_valid_json,
        paragraph_description = excluded.paragraph_description,
        role_json = excluded.role_json,
        title = excluded.title,
        result_files_json = excluded.result_files_json,
        result_text = excluded.result_text,
        raw_outputs_json = excluded.raw_outputs_json,
        error = excluded.error,
        source_kind = CASE
          WHEN tasks.source_kind LIKE 'manual%' THEN tasks.source_kind
          ELSE excluded.source_kind
        END,
        deleted_at = NULL,
        updated_at = excluded.updated_at
    `
    )
    .run(
      task.id,
      batchId,
      task.row_no,
      task.input.book_id,
      task.input.paragraph_content,
      task.input.chapter_sort,
      task.status,
      task.attempts,
      task.started_at ?? null,
      task.finished_at ?? null,
      task.elapsed_seconds ?? null,
      task.workflow_run_id ?? null,
      task.dify_task_id ?? null,
      task.progress_percent ?? null,
      task.progress_label ?? null,
      task.pause_reason ?? null,
      task.stop_requested_at ?? null,
      task.is_valid === undefined ? null : json(task.is_valid),
      task.paragraph_description ?? null,
      task.role ? json(task.role) : null,
      task.title ?? null,
      json(task.result_files),
      task.result_text ?? null,
      task.raw_outputs === undefined ? null : json(task.raw_outputs),
      task.error ?? null,
      sourceKind,
      timestamp,
      timestamp
    );
}

function saveEventRow(batchId: string, event: BatchLogEvent) {
  getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO batch_events (id, batch_id, type, message, created_at, task_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
    .run(event.id, batchId, event.type, event.message, event.createdAt, event.taskId ?? null);
}

export function saveTask(task: BatchTask, batchId?: string | null) {
  saveTaskRow(task, batchId ?? null, batchId ? 'batch' : 'manual');
}

export function markTaskDeleted(taskId: string) {
  getDb().prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), taskId);
}

export function deleteBatchFromStore(batchId: string) {
  const timestamp = now();
  withTransaction(() => {
    getDb()
      .prepare(
        `
        UPDATE tasks
        SET deleted_at = ?, updated_at = ?
        WHERE deleted_at IS NULL
          AND batch_id = ?
          AND id IN (SELECT task_id FROM batch_tasks WHERE batch_id = ?)
      `
      )
      .run(timestamp, timestamp, batchId, batchId);
    getDb().prepare('DELETE FROM batches WHERE id = ?').run(batchId);
  });
}

export function recordTaskRun(task: BatchTask) {
  getDb()
    .prepare(
      `
      INSERT INTO task_runs (
        id, task_id, attempt_no, status, started_at, finished_at, elapsed_seconds,
        workflow_run_id, dify_task_id, is_valid_json, result_files_json, result_text,
        raw_outputs_json, error, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      nanoid(),
      task.id,
      task.attempts,
      task.status,
      task.started_at ?? null,
      task.finished_at ?? null,
      task.elapsed_seconds ?? null,
      task.workflow_run_id ?? null,
      task.dify_task_id ?? null,
      task.is_valid === undefined ? null : json(task.is_valid),
      json(task.result_files),
      task.result_text ?? null,
      task.raw_outputs === undefined ? null : json(task.raw_outputs),
      task.error ?? null,
      now()
    );
}

function taskFromRow(row: SqlRow): BatchTask {
  const task: BatchTask = {
    id: String(row.id),
    batch_id: optionalString(row.batch_id),
    source_kind: optionalString(row.source_kind),
    row_no: Number(row.row_no),
    input: {
      book_id: Number(row.book_id),
      paragraph_content: String(row.paragraph_content ?? ''),
      chapter_sort: Number(row.chapter_sort)
    },
    status: row.status as TaskStatus,
    attempts: Number(row.attempts ?? 0),
    started_at: optionalString(row.started_at),
    finished_at: optionalString(row.finished_at),
    elapsed_seconds: optionalNumber(row.elapsed_seconds),
    workflow_run_id: optionalString(row.workflow_run_id),
    dify_task_id: optionalString(row.dify_task_id),
    progress_percent: optionalNumber(row.progress_percent),
    progress_label: optionalString(row.progress_label),
    pause_reason: optionalString(row.pause_reason) as BatchTask['pause_reason'],
    stop_requested_at: optionalString(row.stop_requested_at),
    is_valid: parseJson(row.is_valid_json, undefined),
    paragraph_description: optionalString(row.paragraph_description),
    role: parseJson<string[] | undefined>(row.role_json, undefined),
    title: optionalString(row.title),
    result_files: parseJson<ResultFile[]>(row.result_files_json, []),
    result_text: optionalString(row.result_text),
    raw_outputs: parseJson(row.raw_outputs_json, undefined),
    error: optionalString(row.error)
  };
  for (const file of task.result_files) {
    registerStoredFile(file);
  }
  return task;
}

function batchFromRow(row: SqlRow): Batch {
  const events = getDb()
    .prepare('SELECT * FROM batch_events WHERE batch_id = ? ORDER BY created_at DESC LIMIT 120')
    .all(String(row.id))
    .map((event): BatchLogEvent => ({
      id: String(event.id),
      type: event.type as BatchLogEvent['type'],
      message: String(event.message),
      createdAt: String(event.created_at),
      taskId: optionalString(event.task_id)
    }));
  const tasks = getDb()
    .prepare(
      `
      SELECT t.*
      FROM batch_tasks bt
      INNER JOIN tasks t ON t.id = bt.task_id
      WHERE bt.batch_id = ? AND t.deleted_at IS NULL
      ORDER BY bt.row_no, t.created_at
    `
    )
    .all(String(row.id))
    .map(taskFromRow);
  return {
    id: String(row.id),
    workbookId: String(row.workbook_id),
    sheetName: String(row.sheet_name),
    fileName: String(row.file_name),
    mapping: parseJson(row.mapping_json, {}) as Batch['mapping'],
    rowLimit: optionalNumber(row.row_limit),
    status: row.status as Batch['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
    pauseRequested: Boolean(row.pause_requested),
    export: parseJson(row.export_json, undefined),
    tasks,
    events
  };
}

export function loadBatchesFromStore() {
  return getDb()
    .prepare('SELECT * FROM batches ORDER BY updated_at DESC')
    .all()
    .map(batchFromRow);
}

function summaryFromRow(row: SqlRow): BookSummary {
  const taskCount = Number(row.task_count ?? 0);
  const running = Number(row.running_count ?? 0);
  const queued = Number(row.queued_count ?? 0);
  const failed = Number(row.failed_count ?? 0);
  const paused = Number(row.paused_count ?? 0);
  return {
    book_id: Number(row.book_id),
    name: optionalString(row.name),
    task_count: taskCount,
    queued_count: queued,
    running_count: running,
    succeeded_count: Number(row.succeeded_count ?? 0),
    failed_count: failed,
    paused_count: paused,
    unfinished_count: queued + running + failed + paused,
    last_task_at: optionalString(row.last_task_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

const bookSummarySql = `
  SELECT
    b.book_id,
    b.name,
    b.created_at,
    b.updated_at,
    COUNT(t.id) AS task_count,
    SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
    SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) AS running_count,
    SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
    SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN t.status = 'paused' THEN 1 ELSE 0 END) AS paused_count,
    MAX(t.updated_at) AS last_task_at
  FROM books b
  LEFT JOIN tasks t ON t.book_id = b.book_id AND t.deleted_at IS NULL
`;

export function listBooks(query = '') {
  const pattern = `%${query.trim()}%`;
  const rows = getDb()
    .prepare(
      `${bookSummarySql}
       WHERE (? = '%%' OR CAST(b.book_id AS TEXT) LIKE ? OR COALESCE(b.name, '') LIKE ?)
       GROUP BY b.book_id
       ORDER BY COALESCE(last_task_at, b.updated_at) DESC, b.book_id ASC`
    )
    .all(pattern, pattern, pattern);
  return rows.map(summaryFromRow);
}

export function getBook(bookId: number): BookDetail | undefined {
  const row = getDb()
    .prepare(
      `${bookSummarySql}
       WHERE b.book_id = ?
       GROUP BY b.book_id`
    )
    .get(bookId);
  if (!row) return undefined;
  const latestBatch = getDb()
    .prepare('SELECT batch_id FROM tasks WHERE book_id = ? AND deleted_at IS NULL AND batch_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1')
    .get(bookId) as SqlRow | undefined;
  return {
    ...summaryFromRow(row),
    latest_batch_id: optionalString(latestBatch?.batch_id)
  };
}

function valueState(value: unknown) {
  if (value === undefined || value === null || value === '') return 'unknown';
  if (typeof value === 'boolean') return value ? 'valuable' : 'not_valuable';
  if (typeof value === 'number') return value === 1 ? 'valuable' : value === 0 ? 'not_valuable' : 'unknown';
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', '有价值', 'valuable'].includes(normalized)) return 'valuable';
    if (['0', 'false', 'no', '无价值', 'not_valuable'].includes(normalized)) return 'not_valuable';
  }
  return 'unknown';
}

function batchSummaryFromRow(row: SqlRow): BookBatchSummary {
  const queued = Number(row.queued_count ?? 0);
  const running = Number(row.running_count ?? 0);
  const failed = Number(row.failed_count ?? 0);
  const paused = Number(row.paused_count ?? 0);
  return {
    id: String(row.id),
    file_name: String(row.file_name ?? ''),
    sheet_name: String(row.sheet_name ?? ''),
    status: row.status as Batch['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    task_count: Number(row.task_count ?? 0),
    queued_count: queued,
    running_count: running,
    succeeded_count: Number(row.succeeded_count ?? 0),
    failed_count: failed,
    paused_count: paused,
    unfinished_count: queued + running + failed + paused
  };
}

export function listBookBatches(bookId: number) {
  return getDb()
    .prepare(
      `
      SELECT
        b.id,
        b.file_name,
        b.sheet_name,
        b.status,
        b.created_at,
        b.updated_at,
        COUNT(t.id) AS task_count,
        SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
        SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN t.status = 'paused' THEN 1 ELSE 0 END) AS paused_count
      FROM batches b
      INNER JOIN batch_tasks bt ON bt.batch_id = b.id
      INNER JOIN tasks t ON t.id = bt.task_id
      WHERE t.book_id = ?
        AND t.deleted_at IS NULL
        AND b.workbook_id NOT LIKE 'book-%'
      GROUP BY b.id
      ORDER BY b.created_at DESC, b.rowid DESC
    `
    )
    .all(bookId)
    .map(batchSummaryFromRow);
}

export function listBookTasks(
  bookId: number,
  filters: {
    status?: string;
    q?: string;
    batchId?: string;
    chapterSortFrom?: number;
    chapterSortTo?: number;
    rowNoFrom?: number;
    rowNoTo?: number;
    hasImage?: string;
    valueStatus?: string;
  } = {}
) {
  const params: SQLInputValue[] = [bookId];
  const clauses = ['book_id = ?', 'deleted_at IS NULL'];
  if (filters.status && filters.status !== 'all') {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.batchId && filters.batchId !== 'all') {
    clauses.push('batch_id = ?');
    params.push(filters.batchId);
  }
  if (filters.chapterSortFrom !== undefined) {
    clauses.push('chapter_sort >= ?');
    params.push(filters.chapterSortFrom);
  }
  if (filters.chapterSortTo !== undefined) {
    clauses.push('chapter_sort <= ?');
    params.push(filters.chapterSortTo);
  }
  if (filters.rowNoFrom !== undefined) {
    clauses.push('row_no >= ?');
    params.push(filters.rowNoFrom);
  }
  if (filters.rowNoTo !== undefined) {
    clauses.push('row_no <= ?');
    params.push(filters.rowNoTo);
  }
  if (filters.hasImage === 'yes') {
    clauses.push("result_files_json IS NOT NULL AND result_files_json != '[]' AND result_files_json != 'null'");
  } else if (filters.hasImage === 'no') {
    clauses.push("(result_files_json IS NULL OR result_files_json = '[]' OR result_files_json = 'null')");
  }
  if (filters.q?.trim()) {
    clauses.push('(paragraph_content LIKE ? OR title LIKE ? OR error LIKE ? OR CAST(chapter_sort AS TEXT) LIKE ?)');
    const pattern = `%${filters.q.trim()}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  const tasks = getDb()
    .prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY row_no ASC, created_at ASC`)
    .all(...params)
    .map(taskFromRow);
  if (!filters.valueStatus || filters.valueStatus === 'all') return tasks;
  return tasks.filter((task) => valueState(task.is_valid) === filters.valueStatus);
}

export function getTask(taskId: string) {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  return row ? taskFromRow(row) : undefined;
}

export function listTaskRuns(taskId: string): TaskRunRecord[] {
  return getDb()
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId)
    .map((row): TaskRunRecord => {
      const resultFiles = parseJson<ResultFile[]>(row.result_files_json, []);
      for (const file of resultFiles) {
        registerStoredFile(file);
      }
      return {
        id: String(row.id),
        task_id: String(row.task_id),
        attempt_no: Number(row.attempt_no),
        status: row.status as TaskStatus,
        started_at: optionalString(row.started_at),
        finished_at: optionalString(row.finished_at),
        elapsed_seconds: optionalNumber(row.elapsed_seconds),
        workflow_run_id: optionalString(row.workflow_run_id),
        dify_task_id: optionalString(row.dify_task_id),
        is_valid: parseJson(row.is_valid_json, undefined),
        result_files: resultFiles,
        result_text: optionalString(row.result_text),
        raw_outputs: parseJson(row.raw_outputs_json, undefined),
        error: optionalString(row.error),
        created_at: String(row.created_at)
      };
    });
}

export function createManualTask(input: BatchTask['input']) {
  const timestamp = now();
  const nextRow = getDb()
    .prepare('SELECT COALESCE(MAX(row_no), 1) + 1 AS row_no FROM tasks WHERE book_id = ? AND deleted_at IS NULL')
    .get(input.book_id) as SqlRow;
  const task: BatchTask = {
    id: nanoid(),
    row_no: Number(nextRow.row_no ?? 2),
    input,
    status: 'queued',
    attempts: 0,
    progress_percent: 0,
    progress_label: '等待执行',
    result_files: []
  };
  saveTaskRow(task, null, 'manual', timestamp);
  return task;
}

export function createTasksForBook(bookId: number, tasks: BatchTask[]) {
  const timestamp = now();
  withTransaction(() => {
    for (const task of tasks) {
      task.input.book_id = bookId;
      saveTaskRow(task, null, 'manual-import', timestamp);
    }
  });
}
