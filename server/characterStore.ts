import { nanoid } from 'nanoid';
import type {
  CharacterColumnMapping,
  CharacterJob,
  CharacterJobEvent,
  CharacterJobSummary,
  CharacterTask,
  CharacterTaskRunRecord,
  ResultFile,
  TaskStatus
} from './types.js';
import { getDb } from './store.js';
import { registerStoredFile } from './fileStore.js';

type SqlRow = Record<string, unknown>;

function now() {
  return new Date().toISOString();
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

function initializeCharacterStore() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_jobs (
      id TEXT PRIMARY KEY,
      workbook_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS character_job_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      row_no INTEGER NOT NULL,
      novel_name TEXT NOT NULL,
      chapter_sort REAL NOT NULL,
      chapter_name TEXT NOT NULL,
      paragraph_content TEXT NOT NULL,
      paragraph_image_url TEXT NOT NULL,
      role_name TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      elapsed_seconds REAL,
      workflow_run_id TEXT,
      dify_task_id TEXT,
      progress_percent REAL,
      progress_label TEXT,
      extracted_role_name TEXT,
      extracted_description TEXT,
      portrait_files_json TEXT NOT NULL DEFAULT '[]',
      result_text TEXT,
      raw_outputs_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES character_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS character_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      elapsed_seconds REAL,
      workflow_run_id TEXT,
      dify_task_id TEXT,
      extracted_role_name TEXT,
      extracted_description TEXT,
      portrait_files_json TEXT NOT NULL DEFAULT '[]',
      result_text TEXT,
      raw_outputs_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES character_job_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS character_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      task_id TEXT,
      FOREIGN KEY (job_id) REFERENCES character_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_character_tasks_job ON character_job_tasks(job_id, row_no);
    CREATE INDEX IF NOT EXISTS idx_character_runs_task ON character_task_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_character_events_job ON character_job_events(job_id, created_at DESC);
  `);
}

function serializeCharacterTask(row: SqlRow): CharacterTask {
  const portraitFiles = parseJson<ResultFile[]>(row.portrait_files_json, []);
  for (const file of portraitFiles) registerStoredFile(file);
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    row_no: Number(row.row_no),
    input: {
      novel_name: String(row.novel_name),
      chapter_sort: Number(row.chapter_sort),
      chapter_name: String(row.chapter_name),
      paragraph_content: String(row.paragraph_content),
      paragraph_image_url: String(row.paragraph_image_url),
      role_name: String(row.role_name)
    },
    status: row.status as TaskStatus,
    attempts: Number(row.attempts),
    started_at: optionalString(row.started_at),
    finished_at: optionalString(row.finished_at),
    elapsed_seconds: optionalNumber(row.elapsed_seconds),
    workflow_run_id: optionalString(row.workflow_run_id),
    dify_task_id: optionalString(row.dify_task_id),
    progress_percent: optionalNumber(row.progress_percent),
    progress_label: optionalString(row.progress_label),
    extracted_role_name: optionalString(row.extracted_role_name),
    extracted_description: optionalString(row.extracted_description),
    portrait_files: portraitFiles,
    result_text: optionalString(row.result_text),
    raw_outputs: parseJson(row.raw_outputs_json, undefined),
    error: optionalString(row.error)
  };
}

function listTasksForJob(jobId: string) {
  initializeCharacterStore();
  return getDb()
    .prepare('SELECT * FROM character_job_tasks WHERE job_id = ? ORDER BY row_no ASC')
    .all(jobId)
    .map((row) => serializeCharacterTask(row as SqlRow));
}

function listEventsForJob(jobId: string) {
  initializeCharacterStore();
  return getDb()
    .prepare('SELECT * FROM character_job_events WHERE job_id = ? ORDER BY created_at DESC')
    .all(jobId)
    .map((row) => ({
      id: String((row as SqlRow).id),
      type: (row as SqlRow).type as CharacterJobEvent['type'],
      message: String((row as SqlRow).message),
      createdAt: String((row as SqlRow).created_at),
      taskId: optionalString((row as SqlRow).task_id)
    }));
}

export function saveCharacterJob(job: CharacterJob) {
  initializeCharacterStore();
  const db = getDb();
  db.prepare(
    `
      INSERT INTO character_jobs (
        id, workbook_id, sheet_name, file_name, mapping_json, prompt_text, status,
        created_at, updated_at, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workbook_id = excluded.workbook_id,
        sheet_name = excluded.sheet_name,
        file_name = excluded.file_name,
        mapping_json = excluded.mapping_json,
        prompt_text = excluded.prompt_text,
        status = excluded.status,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
    `
  ).run(
    job.id,
    job.workbookId,
    job.sheetName,
    job.fileName,
    json(job.mapping),
    job.promptText,
    job.status,
    job.createdAt,
    job.updatedAt,
    job.startedAt ?? null,
    job.finishedAt ?? null
  );

  for (const task of job.tasks) saveCharacterTask(task);
  for (const event of job.events) {
    db.prepare(
      `
        INSERT OR REPLACE INTO character_job_events (id, job_id, type, message, created_at, task_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run(event.id, job.id, event.type, event.message, event.createdAt, event.taskId ?? null);
  }
}

export function saveCharacterTask(task: CharacterTask) {
  initializeCharacterStore();
  getDb()
    .prepare(
      `
        INSERT INTO character_job_tasks (
          id, job_id, row_no, novel_name, chapter_sort, chapter_name, paragraph_content,
          paragraph_image_url, role_name, status, attempts, started_at, finished_at,
          elapsed_seconds, workflow_run_id, dify_task_id, progress_percent, progress_label,
          extracted_role_name, extracted_description, portrait_files_json, result_text,
          raw_outputs_json, error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          elapsed_seconds = excluded.elapsed_seconds,
          workflow_run_id = excluded.workflow_run_id,
          dify_task_id = excluded.dify_task_id,
          progress_percent = excluded.progress_percent,
          progress_label = excluded.progress_label,
          extracted_role_name = excluded.extracted_role_name,
          extracted_description = excluded.extracted_description,
          portrait_files_json = excluded.portrait_files_json,
          result_text = excluded.result_text,
          raw_outputs_json = excluded.raw_outputs_json,
          error = excluded.error,
          updated_at = excluded.updated_at
      `
    )
    .run(
      task.id,
      task.job_id,
      task.row_no,
      task.input.novel_name,
      task.input.chapter_sort,
      task.input.chapter_name,
      task.input.paragraph_content,
      task.input.paragraph_image_url,
      task.input.role_name,
      task.status,
      task.attempts,
      task.started_at ?? null,
      task.finished_at ?? null,
      task.elapsed_seconds ?? null,
      task.workflow_run_id ?? null,
      task.dify_task_id ?? null,
      task.progress_percent ?? null,
      task.progress_label ?? null,
      task.extracted_role_name ?? null,
      task.extracted_description ?? null,
      json(task.portrait_files),
      task.result_text ?? null,
      task.raw_outputs === undefined ? null : json(task.raw_outputs),
      task.error ?? null,
      now(),
      now()
    );
}

export function recordCharacterTaskRun(task: CharacterTask) {
  initializeCharacterStore();
  getDb()
    .prepare(
      `
        INSERT INTO character_task_runs (
          id, task_id, attempt_no, status, started_at, finished_at, elapsed_seconds,
          workflow_run_id, dify_task_id, extracted_role_name, extracted_description,
          portrait_files_json, result_text, raw_outputs_json, error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      task.extracted_role_name ?? null,
      task.extracted_description ?? null,
      json(task.portrait_files),
      task.result_text ?? null,
      task.raw_outputs === undefined ? null : json(task.raw_outputs),
      task.error ?? null,
      now()
    );
}

export function listCharacterTaskRuns(taskId: string): CharacterTaskRunRecord[] {
  initializeCharacterStore();
  return getDb()
    .prepare('SELECT * FROM character_task_runs WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId)
    .map((row) => {
      const files = parseJson<ResultFile[]>((row as SqlRow).portrait_files_json, []);
      for (const file of files) registerStoredFile(file);
      return {
        id: String((row as SqlRow).id),
        task_id: String((row as SqlRow).task_id),
        attempt_no: Number((row as SqlRow).attempt_no),
        status: (row as SqlRow).status as TaskStatus,
        started_at: optionalString((row as SqlRow).started_at),
        finished_at: optionalString((row as SqlRow).finished_at),
        elapsed_seconds: optionalNumber((row as SqlRow).elapsed_seconds),
        workflow_run_id: optionalString((row as SqlRow).workflow_run_id),
        dify_task_id: optionalString((row as SqlRow).dify_task_id),
        extracted_role_name: optionalString((row as SqlRow).extracted_role_name),
        extracted_description: optionalString((row as SqlRow).extracted_description),
        portrait_files: files,
        result_text: optionalString((row as SqlRow).result_text),
        raw_outputs: parseJson((row as SqlRow).raw_outputs_json, undefined),
        error: optionalString((row as SqlRow).error),
        created_at: String((row as SqlRow).created_at)
      };
    });
}

export function getCharacterTaskById(taskId: string) {
  initializeCharacterStore();
  const row = getDb().prepare('SELECT * FROM character_job_tasks WHERE id = ?').get(taskId) as SqlRow | undefined;
  return row ? serializeCharacterTask(row) : undefined;
}

export function getCharacterJob(jobId: string): CharacterJob | undefined {
  initializeCharacterStore();
  const row = getDb().prepare('SELECT * FROM character_jobs WHERE id = ?').get(jobId) as SqlRow | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    workbookId: String(row.workbook_id),
    sheetName: String(row.sheet_name),
    fileName: String(row.file_name),
    mapping: parseJson<CharacterColumnMapping>(row.mapping_json, {} as CharacterColumnMapping),
    promptText: String(row.prompt_text),
    status: row.status as CharacterJob['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
    tasks: listTasksForJob(String(row.id)),
    events: listEventsForJob(String(row.id))
  };
}

export function listCharacterJobs(): CharacterJobSummary[] {
  initializeCharacterStore();
  const rows = getDb()
    .prepare(
      `
        SELECT
          j.id,
          j.file_name,
          j.sheet_name,
          j.status,
          j.created_at,
          j.updated_at,
          COUNT(t.id) AS task_count,
          SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
          SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) AS running_count,
          SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
          SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN t.status = 'paused' THEN 1 ELSE 0 END) AS paused_count
        FROM character_jobs j
        LEFT JOIN character_job_tasks t ON t.job_id = j.id
        GROUP BY j.id
        ORDER BY j.updated_at DESC
      `
    )
    .all() as SqlRow[];
  return rows.map((row) => ({
    id: String(row.id),
    file_name: String(row.file_name),
    sheet_name: String(row.sheet_name),
    status: row.status as CharacterJob['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    task_count: Number(row.task_count),
    queued_count: Number(row.queued_count ?? 0),
    running_count: Number(row.running_count ?? 0),
    succeeded_count: Number(row.succeeded_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    paused_count: Number(row.paused_count ?? 0)
  }));
}
