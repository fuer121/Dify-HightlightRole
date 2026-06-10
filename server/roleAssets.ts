import { nanoid } from 'nanoid';
import type {
  CharacterTask,
  ResultFile,
  RoleAsset,
  RoleAssetProfile,
  RoleAssetSource,
  RoleAssetStatus,
  RoleContextRequest,
  RoleContextResponse
} from './types.js';
import { getDb } from './store.js';
import { registerRemoteFile, registerStoredFile } from './fileStore.js';

type SqlRow = Record<string, unknown>;

export interface RoleAssetListFilters {
  bookId?: number;
  q?: string;
  status?: RoleAssetStatus | 'all';
  hasImage?: 'all' | 'yes' | 'no';
  hasProfile?: 'all' | 'yes' | 'no';
}

export interface RoleAssetInput {
  book_id: number;
  novel_name?: string;
  role_name: string;
  image_file?: ResultFile;
  image_url?: string;
  default_age?: string;
  default_gender?: string;
  default_appearance?: string;
  note?: string;
  status?: RoleAssetStatus;
  source?: RoleAssetSource;
  source_task_id?: string;
}

export interface RoleAssetProfileInput {
  chapter_sort: number;
  age?: string;
  gender?: string;
  appearance?: string;
}

export interface RoleAssetBackfillResult {
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
}

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

function cleanText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRoleName(value: string) {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
}

export function splitRoleNames(value: string) {
  return value
    .split(/[,，、/|]/)
    .map((item) => normalizeRoleName(item))
    .filter(Boolean);
}

export function parseRoleTitle(roleTitle: string) {
  const normalized = roleTitle.trim();
  const roleMatch = normalized.match(/角色[:：]\s*([\s\S]*?)(?:\s+标题[:：]|$)/);
  const titleMatch = normalized.match(/标题[:：]\s*([\s\S]+)$/);
  const roleList = splitRoleNames(roleMatch?.[1] ?? normalized);
  return {
    roleList,
    title: titleMatch?.[1]?.trim() ?? ''
  };
}

function initializeRoleAssetStore() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS role_assets (
      id TEXT PRIMARY KEY,
      book_id REAL NOT NULL,
      novel_name TEXT,
      role_name TEXT NOT NULL,
      image_file_json TEXT,
      image_url TEXT,
      default_age TEXT,
      default_gender TEXT,
      default_appearance TEXT,
      note TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      source_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS role_asset_profiles (
      id TEXT PRIMARY KEY,
      role_asset_id TEXT NOT NULL,
      chapter_sort REAL NOT NULL,
      age TEXT,
      gender TEXT,
      appearance TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (role_asset_id) REFERENCES role_assets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_role_assets_lookup ON role_assets(book_id, role_name, status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_role_profiles_lookup ON role_asset_profiles(role_asset_id, chapter_sort);
  `);
}

function tableExists(tableName: string) {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as SqlRow | undefined;
  return Boolean(row);
}

function serializeProfile(row: SqlRow): RoleAssetProfile {
  return {
    id: String(row.id),
    role_asset_id: String(row.role_asset_id),
    chapter_sort: Number(row.chapter_sort),
    age: optionalString(row.age),
    gender: optionalString(row.gender),
    appearance: optionalString(row.appearance),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function listProfilesForAsset(assetId: string) {
  initializeRoleAssetStore();
  return getDb()
    .prepare('SELECT * FROM role_asset_profiles WHERE role_asset_id = ? ORDER BY chapter_sort ASC, created_at DESC')
    .all(assetId)
    .map((row) => serializeProfile(row as SqlRow));
}

function serializeAsset(row: SqlRow, includeProfiles = false): RoleAsset {
  const imageFile = parseJson<ResultFile | undefined>(row.image_file_json, undefined);
  if (imageFile) registerStoredFile(imageFile);
  return {
    id: String(row.id),
    book_id: Number(row.book_id),
    novel_name: optionalString(row.novel_name),
    role_name: String(row.role_name),
    image_file: imageFile,
    image_url: optionalString(row.image_url),
    default_age: optionalString(row.default_age),
    default_gender: optionalString(row.default_gender),
    default_appearance: optionalString(row.default_appearance),
    note: optionalString(row.note),
    status: row.status as RoleAssetStatus,
    source: row.source as RoleAssetSource,
    source_task_id: optionalString(row.source_task_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    deleted_at: optionalString(row.deleted_at),
    profiles: includeProfiles ? listProfilesForAsset(String(row.id)) : undefined
  };
}

export function createRoleAsset(input: RoleAssetInput) {
  initializeRoleAssetStore();
  const id = nanoid();
  const createdAt = now();
  getDb()
    .prepare(
      `
        INSERT INTO role_assets (
          id, book_id, novel_name, role_name, image_file_json, image_url,
          default_age, default_gender, default_appearance, note, status,
          source, source_task_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      id,
      input.book_id,
      input.novel_name ?? null,
      input.role_name,
      input.image_file ? json(input.image_file) : null,
      input.image_url ?? null,
      input.default_age ?? null,
      input.default_gender ?? null,
      input.default_appearance ?? null,
      input.note ?? null,
      input.status ?? 'draft',
      input.source ?? 'manual',
      input.source_task_id ?? null,
      createdAt,
      createdAt
    );
  return getRoleAsset(id)!;
}

export function getRoleAsset(id: string) {
  initializeRoleAssetStore();
  const row = getDb().prepare('SELECT * FROM role_assets WHERE id = ? AND deleted_at IS NULL').get(id) as SqlRow | undefined;
  return row ? serializeAsset(row, true) : undefined;
}

export function listRoleAssets(filters: RoleAssetListFilters = {}) {
  initializeRoleAssetStore();
  const rows = getDb()
    .prepare('SELECT * FROM role_assets WHERE deleted_at IS NULL ORDER BY updated_at DESC')
    .all()
    .map((row) => serializeAsset(row as SqlRow, true));
  return rows.filter((asset) => {
    if (filters.bookId !== undefined && asset.book_id !== filters.bookId) return false;
    if (filters.status && filters.status !== 'all' && asset.status !== filters.status) return false;
    if (filters.q) {
      const query = filters.q.toLowerCase();
      const haystack = `${asset.novel_name ?? ''} ${asset.role_name}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.hasImage === 'yes' && !asset.image_file && !asset.image_url) return false;
    if (filters.hasImage === 'no' && (asset.image_file || asset.image_url)) return false;
    if (filters.hasProfile === 'yes' && !asset.profiles?.length) return false;
    if (filters.hasProfile === 'no' && asset.profiles?.length) return false;
    return true;
  });
}

export function updateRoleAsset(id: string, patch: Partial<RoleAssetInput>) {
  initializeRoleAssetStore();
  const existing = getRoleAsset(id);
  if (!existing) return undefined;
  getDb()
    .prepare(
      `
        UPDATE role_assets
        SET book_id = ?, novel_name = ?, role_name = ?, image_file_json = ?, image_url = ?,
            default_age = ?, default_gender = ?, default_appearance = ?, note = ?,
            status = ?, source = ?, source_task_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `
    )
    .run(
      patch.book_id ?? existing.book_id,
      patch.novel_name ?? existing.novel_name ?? null,
      patch.role_name ?? existing.role_name,
      patch.image_file !== undefined ? json(patch.image_file) : existing.image_file ? json(existing.image_file) : null,
      patch.image_url !== undefined ? patch.image_url ?? null : existing.image_url ?? null,
      patch.default_age !== undefined ? patch.default_age ?? null : existing.default_age ?? null,
      patch.default_gender !== undefined ? patch.default_gender ?? null : existing.default_gender ?? null,
      patch.default_appearance !== undefined ? patch.default_appearance ?? null : existing.default_appearance ?? null,
      patch.note !== undefined ? patch.note ?? null : existing.note ?? null,
      patch.status ?? existing.status,
      patch.source ?? existing.source,
      patch.source_task_id !== undefined ? patch.source_task_id ?? null : existing.source_task_id ?? null,
      now(),
      id
    );
  return getRoleAsset(id);
}

export function deleteRoleAsset(id: string) {
  initializeRoleAssetStore();
  const result = getDb()
    .prepare('UPDATE role_assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now(), now(), id);
  return result.changes > 0;
}

export function addRoleAssetProfile(assetId: string, input: RoleAssetProfileInput) {
  initializeRoleAssetStore();
  const existing = getDb()
    .prepare('SELECT * FROM role_asset_profiles WHERE role_asset_id = ? AND chapter_sort = ? ORDER BY created_at DESC LIMIT 1')
    .get(assetId, input.chapter_sort) as SqlRow | undefined;
  if (existing) return updateRoleAssetProfile(String(existing.id), input)!;
  const id = nanoid();
  const createdAt = now();
  getDb()
    .prepare(
      `
        INSERT INTO role_asset_profiles (
          id, role_asset_id, chapter_sort, age, gender, appearance, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, assetId, input.chapter_sort, input.age ?? null, input.gender ?? null, input.appearance ?? null, createdAt, createdAt);
  updateRoleAsset(assetId, {});
  return getDb()
    .prepare('SELECT * FROM role_asset_profiles WHERE id = ?')
    .get(id) as SqlRow | undefined
    ? serializeProfile(getDb().prepare('SELECT * FROM role_asset_profiles WHERE id = ?').get(id) as SqlRow)
    : undefined;
}

export function updateRoleAssetProfile(profileId: string, patch: Partial<RoleAssetProfileInput>) {
  initializeRoleAssetStore();
  const row = getDb().prepare('SELECT * FROM role_asset_profiles WHERE id = ?').get(profileId) as SqlRow | undefined;
  if (!row) return undefined;
  getDb()
    .prepare(
      `
        UPDATE role_asset_profiles
        SET chapter_sort = ?, age = ?, gender = ?, appearance = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      patch.chapter_sort ?? Number(row.chapter_sort),
      patch.age !== undefined ? patch.age ?? null : optionalString(row.age) ?? null,
      patch.gender !== undefined ? patch.gender ?? null : optionalString(row.gender) ?? null,
      patch.appearance !== undefined ? patch.appearance ?? null : optionalString(row.appearance) ?? null,
      now(),
      profileId
    );
  updateRoleAsset(String(row.role_asset_id), {});
  return serializeProfile(getDb().prepare('SELECT * FROM role_asset_profiles WHERE id = ?').get(profileId) as SqlRow);
}

export function deleteRoleAssetProfile(profileId: string) {
  initializeRoleAssetStore();
  const row = getDb().prepare('SELECT role_asset_id FROM role_asset_profiles WHERE id = ?').get(profileId) as SqlRow | undefined;
  const result = getDb().prepare('DELETE FROM role_asset_profiles WHERE id = ?').run(profileId);
  if (row) updateRoleAsset(String(row.role_asset_id), {});
  return result.changes > 0;
}

function activeAssetForRole(bookId: number, roleName: string) {
  initializeRoleAssetStore();
  const row = getDb()
    .prepare(
      `
        SELECT * FROM role_assets
        WHERE book_id = ? AND role_name = ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `
    )
    .get(bookId, roleName) as SqlRow | undefined;
  return row ? serializeAsset(row, true) : undefined;
}

function publicUrlForAsset(asset: RoleAsset) {
  const base = process.env.ROLE_ASSET_PUBLIC_BASE_URL;
  if (base && asset.image_file?.previewUrl) {
    return new URL(asset.image_file.previewUrl, base.endsWith('/') ? base : `${base}/`).toString();
  }
  if (asset.image_file?.previewUrl && /^https?:\/\//i.test(asset.image_file.previewUrl)) return asset.image_file.previewUrl;
  if (asset.image_url && /^https?:\/\//i.test(asset.image_url)) return asset.image_url;
  if (asset.image_file?.remoteUrl && /^https?:\/\//i.test(asset.image_file.remoteUrl)) return asset.image_file.remoteUrl;
  const relative = asset.image_file?.previewUrl ?? asset.image_url;
  if (base && relative) return new URL(relative, base.endsWith('/') ? base : `${base}/`).toString();
  return '';
}

function profileForChapter(asset: RoleAsset, chapterSort: number) {
  return asset.profiles?.find((profile) => profile.chapter_sort === chapterSort);
}

function describeRole(asset: RoleAsset, chapterSort: number) {
  const profile = profileForChapter(asset, chapterSort);
  const age = cleanText(profile?.age) ?? cleanText(asset.default_age) ?? '年龄未知';
  const gender = cleanText(profile?.gender) ?? cleanText(asset.default_gender) ?? '性别未知';
  const appearance = cleanText(profile?.appearance) ?? cleanText(asset.default_appearance) ?? '外观未知';
  return `${asset.role_name}(年龄${age},性别${gender},${appearance})`;
}

function buildPrompt(describe: string, roleHavePic: string, roleUrlDescribe: string) {
  if (!roleHavePic) {
    return `请根据如下小说场景描述生成一张高质量小说插画。\n\n【无角色参考图】\n当前没有可用的角色底图，请完全依据文字描述生成角色外观与画面。\n\n【场景描述】\n${describe}`;
  }
  return `请根据如下小说场景与角色参考图生成一张高质量小说插画。\n\n【场景描述】\n${describe}\n\n【角色参考图规则】\n${roleUrlDescribe}\n请严格保持${roleHavePic}的人脸特征、发型、五官、气质、角色身份一致性，如果生图描述中没有服装的描述，服装也完全继承底图。\n但不要直接复用原图构图、姿势、背景与镜头。\n除${roleHavePic}外，其余角色请根据文字描述重新生成。不要参考底图的外观特征，但需要参考风格。`;
}

export function buildWorkflowRoleContext(input: RoleContextRequest): RoleContextResponse {
  const { roleList, title } = parseRoleTitle(input.role_title);
  const assetsWithUrls = roleList
    .map((roleName) => {
      const asset = activeAssetForRole(input.book_id, roleName);
      if (!asset) return undefined;
      const url = publicUrlForAsset(asset);
      if (!url) return undefined;
      return { roleName, asset, url };
    })
    .filter((item): item is { roleName: string; asset: RoleAsset; url: string } => Boolean(item));
  const roleHavePic = assetsWithUrls.map((item) => item.roleName).join(',');
  const roleUrlDescribe = assetsWithUrls.map((item, index) => `第${index + 1}张图是${item.roleName}`).join(';');
  const roleInfo = assetsWithUrls.map((item) => describeRole(item.asset, input.chapter_sort)).join(';');
  return {
    role_url: assetsWithUrls.map((item) => item.url).join('\n'),
    role_list: roleList,
    prompt: buildPrompt(input.describe, roleHavePic, roleUrlDescribe),
    highlight_content: title || input.describe,
    role_url_describe: roleUrlDescribe,
    role_have_pic: roleHavePic,
    role_info: roleInfo ? `${roleInfo};` : ''
  };
}

export function isRoleAssetTokenAuthorized(header: string | undefined) {
  const token = process.env.ROLE_ASSET_API_TOKEN;
  if (!token) return true;
  return header === `Bearer ${token}`;
}

function upsertDraftRoleAsset(input: RoleAssetInput) {
  initializeRoleAssetStore();
  const existing = input.source_task_id
    ? (getDb()
        .prepare(
          `
            SELECT * FROM role_assets
            WHERE role_name = ? AND source_task_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
          `
        )
        .get(input.role_name, input.source_task_id) as SqlRow | undefined)
    : (getDb()
        .prepare(
          `
            SELECT * FROM role_assets
            WHERE book_id = ? AND role_name = ? AND source_task_id IS NULL AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
          `
        )
        .get(input.book_id, input.role_name) as SqlRow | undefined);
  if (existing) return updateRoleAsset(String(existing.id), input)!;
  return createRoleAsset({ ...input, status: input.status ?? 'draft', source: input.source ?? 'character_task' });
}

export function importCharacterTaskToRoleAssets(task: CharacterTask) {
  if (task.status !== 'succeeded' || task.portrait_files.length === 0) return [];
  const bookId = resolveBookIdForNovelName(task.input.novel_name) ?? (Number(task.input.novel_name) || 0);
  const roleNames = splitRoleNames(task.extracted_role_name || task.input.role_name);
  return roleNames.map((roleName) =>
    upsertDraftRoleAsset({
      book_id: bookId,
      novel_name: task.input.novel_name,
      role_name: roleName,
      image_file: task.portrait_files[0],
      default_appearance: task.extracted_description,
      status: 'draft',
      source: 'character_task',
      source_task_id: task.id
    })
  );
}

function resolveBookIdForNovelName(novelName: string) {
  initializeRoleAssetStore();
  const aliasBookId = knownBookIdForNovelName(novelName);
  if (aliasBookId) return aliasBookId;
  const row = getDb().prepare('SELECT book_id FROM books WHERE name = ? LIMIT 1').get(novelName) as SqlRow | undefined;
  const bookId = Number(row?.book_id);
  if (Number.isFinite(bookId) && bookId > 0) return bookId;
  const target = normalizeBookName(novelName);
  if (!target) return undefined;
  const books = getDb().prepare('SELECT book_id, name FROM books WHERE name IS NOT NULL').all() as SqlRow[];
  const ranked = books
    .map((book) => ({
      bookId: Number(book.book_id),
      score: bookNameSimilarity(target, normalizeBookName(String(book.name ?? '')))
    }))
    .filter((item) => Number.isFinite(item.bookId) && item.bookId > 0)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 0.65 || (second && best.score - second.score < 0.15)) return undefined;
  return best.bookId;
}

function normalizeBookName(value: string) {
  return value.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
}

function knownBookIdForNovelName(value: string) {
  const aliases: Record<string, number> = {
    废材又怎么样照样吊打你: 1721648
  };
  return aliases[normalizeBookName(value)];
}

function bookNameSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const leftChars = new Set(Array.from(left));
  const rightChars = new Set(Array.from(right));
  const shared = Array.from(leftChars).filter((char) => rightChars.has(char)).length;
  return shared / Math.max(leftChars.size, rightChars.size);
}

function serializeCharacterTaskRow(row: SqlRow): CharacterTask {
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
    status: row.status as CharacterTask['status'],
    attempts: Number(row.attempts),
    started_at: optionalString(row.started_at),
    finished_at: optionalString(row.finished_at),
    elapsed_seconds: typeof row.elapsed_seconds === 'number' ? row.elapsed_seconds : undefined,
    workflow_run_id: optionalString(row.workflow_run_id),
    dify_task_id: optionalString(row.dify_task_id),
    progress_percent: typeof row.progress_percent === 'number' ? row.progress_percent : undefined,
    progress_label: optionalString(row.progress_label),
    extracted_role_name: optionalString(row.extracted_role_name),
    extracted_description: optionalString(row.extracted_description),
    portrait_files: portraitFiles,
    result_text: optionalString(row.result_text),
    raw_outputs: parseJson(row.raw_outputs_json, undefined),
    error: optionalString(row.error)
  };
}

export function backfillCharacterRoleAssets(): RoleAssetBackfillResult {
  initializeRoleAssetStore();
  if (!tableExists('character_job_tasks')) {
    return { scanned: 0, imported: 0, updated: 0, skipped: 0 };
  }
  const tasks = getDb()
    .prepare(
      `
        SELECT *
        FROM character_job_tasks
        WHERE status = 'succeeded'
          AND portrait_files_json IS NOT NULL
          AND portrait_files_json != '[]'
        ORDER BY finished_at ASC, row_no ASC
      `
    )
    .all()
    .map((row) => serializeCharacterTaskRow(row as SqlRow));
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const task of tasks) {
    const before = listRoleAssets({}).length;
    const assets = importCharacterTaskToRoleAssets(task);
    const after = listRoleAssets({}).length;
    const created = Math.max(0, after - before);
    if (assets.length === 0) {
      skipped += 1;
    } else if (created > 0) {
      imported += created;
    } else {
      updated += assets.length;
    }
  }
  return { scanned: tasks.length, imported, updated, skipped };
}

export function importCharacterTaskPayload(payload: {
  task: CharacterTask;
  book_id?: number;
  role_name?: string;
  image_url?: string;
  status?: RoleAssetStatus;
}) {
  const roleNames = splitRoleNames(payload.role_name || payload.task.extracted_role_name || payload.task.input.role_name);
  return roleNames.map((roleName) => {
    const imageFile = payload.task.portrait_files[0];
    const remoteImage = payload.image_url ? registerRemoteFile(payload.task.id, payload.image_url, `${roleName}.png`) : undefined;
    const bookId = payload.book_id ?? resolveBookIdForNovelName(payload.task.input.novel_name) ?? (Number(payload.task.input.novel_name) || 0);
    return upsertDraftRoleAsset({
      book_id: bookId,
      novel_name: payload.task.input.novel_name,
      role_name: roleName,
      image_file: remoteImage ?? imageFile,
      default_appearance: payload.task.extracted_description,
      status: payload.status ?? 'draft',
      source: 'character_task',
      source_task_id: payload.task.id
    });
  });
}
