import type { ManagedWorkflowConfig, ManagedWorkflowGroup, ManagedWorkflowId, WorkflowGroupStatus } from './types.js';
import { getDb } from './store.js';

type SqlRow = Record<string, unknown>;

export const DEFAULT_WORKFLOW_GROUP_ID = 'default';

export interface WorkflowConfigPatch {
  name?: string;
  api_key?: string;
  console_url?: string;
  note?: string;
}

export interface WorkflowGroupPatch {
  name?: string;
  status?: WorkflowGroupStatus;
  note?: string;
}

export interface WorkflowGroupCreate {
  id: string;
  name: string;
  note?: string;
}

function now() {
  return new Date().toISOString();
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown) {
  return value === true || value === 1;
}

export function isManagedWorkflowId(value: string): value is ManagedWorkflowId {
  return value === 'primary' || value === 'compare';
}

export function isWorkflowGroupStatus(value: string): value is WorkflowGroupStatus {
  return value === 'active' || value === 'disabled';
}

function assertWorkflowGroupId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('分组 ID 只能包含字母、数字、下划线或短横线，且必须以字母或数字开头');
  }
}

function legacyWorkflowDefaults(id: ManagedWorkflowId): Pick<ManagedWorkflowConfig, 'id' | 'name' | 'api_key' | 'console_url' | 'note'> {
  const legacy = getDb().prepare('SELECT * FROM workflow_configs WHERE id = ?').get(id) as SqlRow | undefined;
  if (legacy) {
    return {
      id,
      name: String(legacy.name),
      api_key: optionalString(legacy.api_key),
      console_url: optionalString(legacy.console_url),
      note: optionalString(legacy.note)
    };
  }

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

function emptyWorkflowDefaults(id: ManagedWorkflowId): Pick<ManagedWorkflowConfig, 'id' | 'name' | 'api_key' | 'console_url' | 'note'> {
  return {
    id,
    name: id === 'primary' ? '主工作流' : '对照工作流',
    api_key: undefined,
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

    CREATE TABLE IF NOT EXISTS workflow_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_group_configs (
      group_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      api_key TEXT,
      console_url TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_id, workflow_id),
      FOREIGN KEY (group_id) REFERENCES workflow_groups(id) ON DELETE CASCADE
    );
  `);
}

function serializeWorkflowConfig(row: SqlRow): ManagedWorkflowConfig {
  return {
    id: String(row.workflow_id ?? row.id) as ManagedWorkflowId,
    group_id: optionalString(row.group_id),
    name: String(row.name),
    api_key: optionalString(row.api_key),
    console_url: optionalString(row.console_url),
    note: optionalString(row.note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function workflowConfigsForGroup(groupId: string) {
  ensureWorkflowConfigStore();
  ensureGroupWorkflowSlots(groupId);
  return getDb()
    .prepare('SELECT * FROM workflow_group_configs WHERE group_id = ? ORDER BY CASE workflow_id WHEN ? THEN 0 ELSE 1 END')
    .all(groupId, 'primary')
    .map(serializeWorkflowConfig);
}

function serializeWorkflowGroup(row: SqlRow): ManagedWorkflowGroup {
  const groupId = String(row.id);
  return {
    id: groupId,
    name: String(row.name),
    status: row.status as WorkflowGroupStatus,
    is_default: boolValue(row.is_default),
    note: optionalString(row.note),
    workflows: workflowConfigsForGroup(groupId),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function ensureDefaultWorkflowGroup() {
  initializeWorkflowConfigStore();
  const existing = getDb().prepare('SELECT * FROM workflow_groups WHERE id = ?').get(DEFAULT_WORKFLOW_GROUP_ID) as SqlRow | undefined;
  if (!existing) {
    const createdAt = now();
    getDb()
      .prepare(
        `
        INSERT INTO workflow_groups (id, name, status, is_default, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(DEFAULT_WORKFLOW_GROUP_ID, '默认分组', 'active', 1, '由旧 primary/compare 配置迁移而来', createdAt, createdAt);
  }
  ensureGroupWorkflowSlots(DEFAULT_WORKFLOW_GROUP_ID, true);
}

function ensureWorkflowConfigStore() {
  initializeWorkflowConfigStore();
  const defaultRow = getDb().prepare('SELECT id FROM workflow_groups WHERE id = ?').get(DEFAULT_WORKFLOW_GROUP_ID);
  if (!defaultRow) ensureDefaultWorkflowGroup();
}

function ensureGroupWorkflowSlots(groupId: string, useLegacyDefaults = false) {
  initializeWorkflowConfigStore();
  for (const workflowId of ['primary', 'compare'] as ManagedWorkflowId[]) {
    const existing = getDb()
      .prepare('SELECT group_id FROM workflow_group_configs WHERE group_id = ? AND workflow_id = ?')
      .get(groupId, workflowId);
    if (existing) continue;

    const defaults = useLegacyDefaults ? legacyWorkflowDefaults(workflowId) : emptyWorkflowDefaults(workflowId);
    const createdAt = now();
    getDb()
      .prepare(
        `
        INSERT INTO workflow_group_configs (group_id, workflow_id, name, api_key, console_url, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        groupId,
        defaults.id,
        defaults.name,
        defaults.api_key ?? null,
        defaults.console_url ?? null,
        defaults.note ?? null,
        createdAt,
        createdAt
      );
  }
}

export function listWorkflowGroups(includeDisabled = true) {
  ensureWorkflowConfigStore();
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM workflow_groups
      WHERE (? = 1 OR status = 'active')
      ORDER BY is_default DESC, updated_at DESC, id ASC
    `
    )
    .all(includeDisabled ? 1 : 0);
  return rows.map(serializeWorkflowGroup);
}

export function listActiveWorkflowGroups() {
  return listWorkflowGroups(false);
}

export function getWorkflowGroup(groupId = DEFAULT_WORKFLOW_GROUP_ID) {
  ensureWorkflowConfigStore();
  const row = getDb().prepare('SELECT * FROM workflow_groups WHERE id = ?').get(groupId) as SqlRow | undefined;
  return row ? serializeWorkflowGroup(row) : undefined;
}

export function requireActiveWorkflowGroup(groupId = DEFAULT_WORKFLOW_GROUP_ID) {
  const group = getWorkflowGroup(groupId);
  if (!group) throw new Error(`Workflow 分组不存在：${groupId}`);
  if (group.status !== 'active') throw new Error(`Workflow 分组已禁用：${group.name}`);
  return group;
}

export function getWorkflowConfigsForGroup(groupId = DEFAULT_WORKFLOW_GROUP_ID) {
  const group = getWorkflowGroup(groupId);
  if (!group) throw new Error(`Workflow 分组不存在：${groupId}`);
  return group.workflows;
}

export function listWorkflowConfigs() {
  return getWorkflowConfigsForGroup(DEFAULT_WORKFLOW_GROUP_ID);
}

export function getWorkflowConfig(id: ManagedWorkflowId) {
  const workflow = listWorkflowConfigs().find((item) => item.id === id);
  if (!workflow) throw new Error('工作流不存在');
  return workflow;
}

export function createWorkflowGroup(input: WorkflowGroupCreate) {
  ensureWorkflowConfigStore();
  const groupId = input.id.trim();
  assertWorkflowGroupId(groupId);
  const name = input.name.trim();
  if (!name) throw new Error('分组名称不能为空');
  if (getWorkflowGroup(groupId)) throw new Error('Workflow 分组 ID 已存在');

  const createdAt = now();
  getDb()
    .prepare(
      `
      INSERT INTO workflow_groups (id, name, status, is_default, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(groupId, name, 'active', 0, input.note?.trim() || null, createdAt, createdAt);
  ensureGroupWorkflowSlots(groupId);
  return getWorkflowGroup(groupId)!;
}

export function updateWorkflowGroup(groupId: string, patch: WorkflowGroupPatch) {
  ensureWorkflowConfigStore();
  const existing = getWorkflowGroup(groupId);
  if (!existing) throw new Error('Workflow 分组不存在');
  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new Error('分组名称不能为空');
  const nextStatus = patch.status ?? existing.status;
  if (!isWorkflowGroupStatus(nextStatus)) throw new Error('分组状态不合法');
  if (existing.is_default && nextStatus === 'disabled') throw new Error('默认分组不能禁用');

  getDb()
    .prepare(
      `
      UPDATE workflow_groups
      SET name = ?, status = ?, note = ?, updated_at = ?
      WHERE id = ?
    `
    )
    .run(nextName, nextStatus, patch.note !== undefined ? patch.note.trim() || null : existing.note ?? null, now(), groupId);
  return getWorkflowGroup(groupId)!;
}

export function updateWorkflowGroupWorkflow(groupId: string, workflowId: ManagedWorkflowId, patch: WorkflowConfigPatch) {
  ensureWorkflowConfigStore();
  const group = getWorkflowGroup(groupId);
  if (!group) throw new Error('Workflow 分组不存在');
  const existing = group.workflows.find((item) => item.id === workflowId);
  if (!existing) throw new Error('工作流不存在');
  const nextName = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!nextName) throw new Error('工作流名称不能为空');

  getDb()
    .prepare(
      `
      UPDATE workflow_group_configs
      SET name = ?, api_key = ?, console_url = ?, note = ?, updated_at = ?
      WHERE group_id = ? AND workflow_id = ?
    `
    )
    .run(
      nextName,
      patch.api_key !== undefined ? patch.api_key.trim() || null : existing.api_key ?? null,
      patch.console_url !== undefined ? patch.console_url.trim() || null : existing.console_url ?? null,
      patch.note !== undefined ? patch.note.trim() || null : existing.note ?? null,
      now(),
      groupId,
      workflowId
    );
  return getWorkflowGroup(groupId)!;
}

export function updateWorkflowConfig(id: ManagedWorkflowId, patch: WorkflowConfigPatch) {
  return updateWorkflowGroupWorkflow(DEFAULT_WORKFLOW_GROUP_ID, id, patch).workflows.find((workflow) => workflow.id === id)!;
}
