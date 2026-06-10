import type { ManagedWorkflowConfig, ManagedWorkflowId } from './types.js';
import { getDb } from './store.js';

type SqlRow = Record<string, unknown>;

export interface WorkflowConfigPatch {
  name?: string;
  api_key?: string;
  console_url?: string;
  note?: string;
}

function now() {
  return new Date().toISOString();
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function workflowDefaults(id: ManagedWorkflowId): Pick<ManagedWorkflowConfig, 'id' | 'name' | 'api_key' | 'console_url' | 'note'> {
  if (id === 'compare') {
    return {
      id,
      name: process.env.DIFY_COMPARE_WORKFLOW_NAME ?? '对照工作流',
      api_key: process.env.DIFY_COMPARE_API_KEY,
      console_url: undefined,
      note: undefined
    };
  }
  return {
    id,
    name: process.env.DIFY_WORKFLOW_NAME ?? '线上工作流',
    api_key: process.env.DIFY_API_KEY,
    console_url: undefined,
    note: undefined
  };
}

function initializeWorkflowConfigStore() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS workflow_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT,
      console_url TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function serializeWorkflowConfig(row: SqlRow): ManagedWorkflowConfig {
  return {
    id: String(row.id) as ManagedWorkflowId,
    name: String(row.name),
    api_key: optionalString(row.api_key),
    console_url: optionalString(row.console_url),
    note: optionalString(row.note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function ensureWorkflowConfig(id: ManagedWorkflowId) {
  initializeWorkflowConfigStore();
  const row = getDb().prepare('SELECT * FROM workflow_configs WHERE id = ?').get(id) as SqlRow | undefined;
  if (row) return serializeWorkflowConfig(row);

  const defaults = workflowDefaults(id);
  const createdAt = now();
  getDb()
    .prepare(
      `
        INSERT INTO workflow_configs (id, name, api_key, console_url, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      defaults.id,
      defaults.name,
      defaults.api_key ?? null,
      defaults.console_url ?? null,
      defaults.note ?? null,
      createdAt,
      createdAt
    );
  return serializeWorkflowConfig(getDb().prepare('SELECT * FROM workflow_configs WHERE id = ?').get(id) as SqlRow);
}

export function isManagedWorkflowId(value: string): value is ManagedWorkflowId {
  return value === 'primary' || value === 'compare';
}

export function listWorkflowConfigs() {
  return [ensureWorkflowConfig('primary'), ensureWorkflowConfig('compare')];
}

export function getWorkflowConfig(id: ManagedWorkflowId) {
  return ensureWorkflowConfig(id);
}

export function updateWorkflowConfig(id: ManagedWorkflowId, patch: WorkflowConfigPatch) {
  const existing = ensureWorkflowConfig(id);
  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new Error('工作流名称不能为空');

  getDb()
    .prepare(
      `
        UPDATE workflow_configs
        SET name = ?, api_key = ?, console_url = ?, note = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      nextName,
      patch.api_key !== undefined ? patch.api_key.trim() || null : existing.api_key ?? null,
      patch.console_url !== undefined ? patch.console_url.trim() || null : existing.console_url ?? null,
      patch.note !== undefined ? patch.note.trim() || null : existing.note ?? null,
      now(),
      id
    );
  return getWorkflowConfig(id);
}
