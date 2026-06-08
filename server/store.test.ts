import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchTask } from './types.js';
import { closeStoreForTest, getDb, listTaskRuns, recordTaskRun, saveTask } from './store.js';

function makeTask(overrides: Partial<BatchTask> = {}): BatchTask {
  return {
    id: 'task-1',
    row_no: 2,
    input: {
      book_id: 1,
      paragraph_content: '高光段落',
      chapter_sort: 2
    },
    status: 'succeeded',
    attempts: 1,
    result_files: [],
    ...overrides
  };
}

describe('store task run is_valid persistence', () => {
  afterEach(() => {
    closeStoreForTest();
    delete process.env.BATCH_STORE_PATH;
  });

  it('records run-level is_valid separately from raw_outputs', () => {
    const task = makeTask({
      is_valid: 1,
      raw_outputs: { title: '只有标题，没有 is_valid' }
    });

    saveTask(task);
    recordTaskRun(task);

    const runs = listTaskRuns(task.id);

    expect(runs).toHaveLength(1);
    expect(runs[0].is_valid).toBe(1);
    expect(runs[0].raw_outputs).toEqual({ title: '只有标题，没有 is_valid' });
  });

  it('adds the run-level is_valid column when opening an older store', () => {
    const dbPath = path.join(os.tmpdir(), `dify-batch-store-${Date.now()}-${Math.random()}.sqlite`);
    process.env.BATCH_STORE_PATH = dbPath;
    closeStoreForTest();

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      PRAGMA foreign_keys = OFF;

      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        elapsed_seconds REAL,
        workflow_run_id TEXT,
        dify_task_id TEXT,
        result_files_json TEXT NOT NULL DEFAULT '[]',
        result_text TEXT,
        raw_outputs_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    const task = makeTask({
      id: 'task-legacy',
      is_valid: 0,
      raw_outputs: { title: '迁移后写入' }
    });

    saveTask(task);
    recordTaskRun(task);

    const columns = getDb()
      .prepare("SELECT name FROM pragma_table_info('task_runs') WHERE name = 'is_valid_json'")
      .all() as Array<{ name: string }>;
    const runs = listTaskRuns(task.id);

    expect(columns).toEqual([{ name: 'is_valid_json' }]);
    expect(runs).toHaveLength(1);
    expect(runs[0].is_valid).toBe(0);
  });

  it('does not backfill old runs from the current task is_valid', () => {
    const task = makeTask({
      id: 'task-history',
      is_valid: 1
    });

    saveTask(task);
    getDb()
      .prepare(
        `
        INSERT INTO task_runs (
          id, task_id, attempt_no, status, started_at, finished_at, elapsed_seconds,
          workflow_run_id, dify_task_id, result_files_json, result_text, raw_outputs_json,
          error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        'run-history',
        task.id,
        1,
        'succeeded',
        null,
        null,
        null,
        'workflow-history',
        'dify-history',
        '[]',
        null,
        JSON.stringify({ title: '历史记录没有 is_valid' }),
        null,
        new Date().toISOString()
      );

    const [run] = listTaskRuns(task.id);

    expect(run.is_valid).toBeUndefined();
    expect(run.raw_outputs).toEqual({ title: '历史记录没有 is_valid' });
  });
});
