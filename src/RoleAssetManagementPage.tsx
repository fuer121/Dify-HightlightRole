import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, ImageIcon, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

type RoleAssetStatus = 'draft' | 'active' | 'disabled';
type RoleAssetSource = 'manual' | 'character_task' | 'import';

interface ResultFile {
  id: string;
  name: string;
  mimeType: string;
  previewUrl: string;
  remoteUrl?: string;
}

interface RoleAssetProfile {
  id: string;
  role_asset_id: string;
  chapter_sort: number;
  age?: string;
  gender?: string;
  appearance?: string;
  created_at: string;
  updated_at: string;
}

interface RoleAsset {
  id: string;
  book_id: number;
  novel_name?: string;
  role_name: string;
  image_file?: ResultFile;
  image_url?: string;
  default_age?: string;
  default_gender?: string;
  default_appearance?: string;
  note?: string;
  status: RoleAssetStatus;
  source: RoleAssetSource;
  source_task_id?: string;
  created_at: string;
  updated_at: string;
  profiles?: RoleAssetProfile[];
}

interface LarkExportResult {
  baseToken?: string;
  baseUrl?: string;
  tableId?: string;
  tableName: string;
  createdAt: string;
  recordsCreated: number;
  attachmentsUploaded: number;
  attachmentsFailed?: number;
}

const statusLabel: Record<RoleAssetStatus, string> = {
  draft: '待确认',
  active: '已启用',
  disabled: '已禁用'
};

const sourceLabel: Record<RoleAssetSource, string> = {
  manual: '手动维护',
  character_task: '角色提取沉淀',
  import: '导入'
};

function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    return response.json().catch(() => ({})).then((payload) => {
      const message = typeof payload === 'object' && payload && 'error' in payload ? String(payload.error) : `请求失败 ${response.status}`;
      throw new Error(message);
    });
  }
  return response.json() as Promise<T>;
}

function imageSrc(asset: RoleAsset | null) {
  if (!asset) return '';
  return asset.image_file?.previewUrl || asset.image_url || '';
}

function emptyAssetForm() {
  return {
    book_id: '',
    novel_name: '',
    role_name: '',
    image_url: '',
    default_age: '',
    default_gender: '',
    default_appearance: '',
    note: '',
    status: 'draft' as RoleAssetStatus
  };
}

function assetToForm(asset: RoleAsset) {
  return {
    book_id: String(asset.book_id || ''),
    novel_name: asset.novel_name ?? '',
    role_name: asset.role_name,
    image_url: asset.image_url ?? '',
    default_age: asset.default_age ?? '',
    default_gender: asset.default_gender ?? '',
    default_appearance: asset.default_appearance ?? '',
    note: asset.note ?? '',
    status: asset.status
  };
}

export function RoleAssetManagementPage() {
  const [assets, setAssets] = useState<RoleAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    bookId: '',
    q: '',
    status: 'all',
    hasImage: 'all',
    hasProfile: 'all'
  });
  const selectedAsset = useMemo(() => assets.find((asset) => asset.id === selectedId) ?? assets[0] ?? null, [assets, selectedId]);
  const [form, setForm] = useState(emptyAssetForm);
  const [profileForm, setProfileForm] = useState({ chapter_sort: '', age: '', gender: '', appearance: '' });
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isBackfilling, setBackfilling] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<LarkExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function updateForm(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function loadAssets() {
    const params = new URLSearchParams();
    if (filters.bookId.trim()) params.set('bookId', filters.bookId.trim());
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.hasImage !== 'all') params.set('hasImage', filters.hasImage);
    if (filters.hasProfile !== 'all') params.set('hasProfile', filters.hasProfile);
    setLoading(true);
    setError(null);
    setExportResult(null);
    try {
      const payload = await fetch(`/api/role-assets?${params}`).then((response) => readJson<{ assets: RoleAsset[] }>(response));
      setAssets(payload.assets);
      if (payload.assets.length > 0 && !payload.assets.some((asset) => asset.id === selectedId)) {
        setSelectedId(payload.assets[0].id);
        setForm(assetToForm(payload.assets[0]));
      }
      if (payload.assets.length === 0) {
        setSelectedId(null);
        setForm(emptyAssetForm());
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function backfillCharacterTasks() {
    setBackfilling(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await fetch('/api/role-assets/backfill-character-tasks', { method: 'POST' }).then((response) =>
        readJson<{ result: { scanned: number; imported: number; updated: number; skipped: number } }>(response)
      );
      setNotice(
        `已扫描 ${payload.result.scanned} 条成功立绘，新增 ${payload.result.imported} 条候选，更新 ${payload.result.updated} 条，跳过 ${payload.result.skipped} 条。`
      );
      await loadAssets();
    } catch (backfillError) {
      setError(backfillError instanceof Error ? backfillError.message : '导入存量立绘失败');
    } finally {
      setBackfilling(false);
    }
  }

  async function exportRoleAssets() {
    setExporting(true);
    setError(null);
    setNotice(null);
    setExportResult(null);
    try {
      const result = await fetch('/api/role-assets/export/lark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: assets.map((asset) => asset.id) })
      }).then((response) => readJson<LarkExportResult>(response));
      setExportResult(result);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出飞书失败');
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => void loadAssets());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectAsset(asset: RoleAsset) {
    setSelectedId(asset.id);
    setForm(assetToForm(asset));
  }

  async function saveAsset(asNew = false) {
    setError(null);
    const body = new FormData();
    body.set('book_id', form.book_id);
    body.set('novel_name', form.novel_name);
    body.set('role_name', form.role_name);
    body.set('image_url', form.image_url);
    body.set('default_age', form.default_age);
    body.set('default_gender', form.default_gender);
    body.set('default_appearance', form.default_appearance);
    body.set('note', form.note);
    body.set('status', form.status);
    if (file) body.set('image', file);
    const url = asNew || !selectedAsset ? '/api/role-assets' : `/api/role-assets/${selectedAsset.id}`;
    const method = asNew || !selectedAsset ? 'POST' : 'PATCH';
    try {
      const payload = await fetch(url, { method, body }).then((response) => readJson<{ asset: RoleAsset }>(response));
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadAssets();
      setSelectedId(payload.asset.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
    }
  }

  async function patchStatus(status: RoleAssetStatus) {
    if (!selectedAsset) return;
    await fetch(`/api/role-assets/${selectedAsset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    }).then((response) => readJson<{ asset: RoleAsset }>(response));
    await loadAssets();
  }

  async function deleteSelected() {
    if (!selectedAsset) return;
    await fetch(`/api/role-assets/${selectedAsset.id}`, { method: 'DELETE' }).then((response) => readJson<{ ok: boolean }>(response));
    await loadAssets();
  }

  async function addProfile() {
    if (!selectedAsset) return;
    await fetch(`/api/role-assets/${selectedAsset.id}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profileForm)
    }).then((response) => readJson<{ profile: RoleAssetProfile }>(response));
    setProfileForm({ chapter_sort: '', age: '', gender: '', appearance: '' });
    await loadAssets();
  }

  async function deleteProfile(profileId: string) {
    if (!selectedAsset) return;
    await fetch(`/api/role-assets/${selectedAsset.id}/profiles/${profileId}`, { method: 'DELETE' }).then((response) =>
      readJson<{ ok: boolean }>(response)
    );
    await loadAssets();
  }

  return (
    <section className="quality-layout role-assets-layout">
      <aside className="left-panel quality-left role-assets-left">
        <div className="panel-section">
          <div className="panel-title">
            <Database size={16} />
            <span>筛选角色底图</span>
          </div>
          <div className="role-assets-filter-grid">
            <label>
              书籍 ID
              <input value={filters.bookId} onChange={(event) => updateFilter('bookId', event.target.value)} placeholder="book_id" />
            </label>
            <label>
              角色 / 书名
              <input value={filters.q} onChange={(event) => updateFilter('q', event.target.value)} placeholder="输入关键词" />
            </label>
            <label>
              启用状态
              <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
                <option value="all">全部状态</option>
                <option value="draft">待确认</option>
                <option value="active">已启用</option>
                <option value="disabled">已禁用</option>
              </select>
            </label>
            <label>
              是否有底图
              <select value={filters.hasImage} onChange={(event) => updateFilter('hasImage', event.target.value)}>
                <option value="all">全部</option>
                <option value="yes">有底图</option>
                <option value="no">无底图</option>
              </select>
            </label>
            <label>
              章节画像
              <select value={filters.hasProfile} onChange={(event) => updateFilter('hasProfile', event.target.value)}>
                <option value="all">全部</option>
                <option value="yes">已维护</option>
                <option value="no">未维护</option>
              </select>
            </label>
          </div>
          <button className="primary-button full-width-button" onClick={loadAssets} disabled={isLoading}>
            <RefreshCw size={15} /> 查询
          </button>
          <button className="secondary-button full-width-button" onClick={backfillCharacterTasks} disabled={isBackfilling}>
            <Database size={15} /> {isBackfilling ? '导入中' : '导入存量立绘'}
          </button>
          <button className="secondary-button full-width-button" onClick={exportRoleAssets} disabled={isExporting || assets.length === 0}>
            <Database size={15} /> {isExporting ? '导出中' : '导出飞书'}
          </button>
          {notice && <p className="inline-success">{notice}</p>}
          {exportResult && (
            <p className="inline-success">
              飞书 Base：
              {exportResult.baseUrl ? (
                <a href={exportResult.baseUrl} target="_blank" rel="noreferrer">
                  {exportResult.tableName}
                </a>
              ) : (
                exportResult.tableName
              )}
              ，已导出 {exportResult.recordsCreated} 行，上传附件 {exportResult.attachmentsUploaded} 个
              {exportResult.attachmentsFailed ? `，${exportResult.attachmentsFailed} 个附件失败` : ''}
            </p>
          )}
        </div>

        <div className="panel-section">
          <div className="panel-title">
            <Plus size={16} />
            <span>新增 / 编辑</span>
          </div>
          <div className="role-assets-form">
            <input value={form.book_id} onChange={(event) => updateForm('book_id', event.target.value)} placeholder="book_id，例如 1721648" />
            <input value={form.novel_name} onChange={(event) => updateForm('novel_name', event.target.value)} placeholder="小说名" />
            <input value={form.role_name} onChange={(event) => updateForm('role_name', event.target.value)} placeholder="角色名" />
            <input value={form.image_url} onChange={(event) => updateForm('image_url', event.target.value)} placeholder="CDN 底图 URL" />
            <input ref={fileInputRef} type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <input value={form.default_age} onChange={(event) => updateForm('default_age', event.target.value)} placeholder="默认年龄" />
            <input value={form.default_gender} onChange={(event) => updateForm('default_gender', event.target.value)} placeholder="默认性别" />
            <textarea
              value={form.default_appearance}
              onChange={(event) => updateForm('default_appearance', event.target.value)}
              placeholder="默认外观描述"
              rows={4}
            />
            <textarea value={form.note} onChange={(event) => updateForm('note', event.target.value)} placeholder="备注" rows={2} />
            <select value={form.status} onChange={(event) => updateForm('status', event.target.value as RoleAssetStatus)}>
              <option value="draft">待确认</option>
              <option value="active">已启用</option>
              <option value="disabled">已禁用</option>
            </select>
          </div>
          <div className="role-assets-actions">
            <button onClick={() => saveAsset(false)} disabled={!form.book_id || !form.role_name}>
              <Save size={15} /> 保存选中
            </button>
            <button onClick={() => saveAsset(true)} disabled={!form.book_id || !form.role_name}>
              <Plus size={15} /> 新增
            </button>
          </div>
          {error && <p className="inline-error">{error}</p>}
        </div>
      </aside>

      <section className="quality-main main-panel role-assets-main">
        <div className="task-surface">
          <div className="role-assets-summary">
            <strong>{assets.length}</strong>
            <span>条角色底图记录</span>
            <small>workflow 只读取已启用记录</small>
          </div>
          <div className="role-assets-table-wrap">
            <table className="role-assets-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>底图</th>
                  <th>书籍</th>
                  <th>角色</th>
                  <th>默认画像</th>
                  <th>章节画像</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id} className={selectedAsset?.id === asset.id ? 'selected' : ''} onClick={() => selectAsset(asset)}>
                    <td>
                      <span className={`asset-status ${asset.status}`}>{statusLabel[asset.status]}</span>
                    </td>
                    <td>
                      {imageSrc(asset) ? <img src={imageSrc(asset)} alt={asset.role_name} /> : <span className="empty-thumb">无图</span>}
                    </td>
                    <td>
                      <strong>{asset.novel_name || asset.book_id}</strong>
                      <small>{asset.book_id}</small>
                    </td>
                    <td>{asset.role_name}</td>
                    <td className="muted-cell">{asset.default_appearance || asset.default_age || asset.default_gender || '-'}</td>
                    <td>{asset.profiles?.length ?? 0} 条</td>
                    <td>{sourceLabel[asset.source] ?? asset.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <aside className="right-panel quality-right role-assets-detail">
        <div className="panel-section result-panel">
          <div className="panel-title">
            <ImageIcon size={16} />
            <span>角色底图详情</span>
          </div>
          {selectedAsset ? (
            <>
              <div className="role-asset-preview">
                {imageSrc(selectedAsset) ? <img src={imageSrc(selectedAsset)} alt={selectedAsset.role_name} /> : <div>暂无底图</div>}
              </div>
              <div className="role-asset-meta">
                <strong>{selectedAsset.role_name}</strong>
                <span>{selectedAsset.novel_name || `书籍 ${selectedAsset.book_id}`}</span>
                <span>{statusLabel[selectedAsset.status]}</span>
              </div>
              <div className="role-assets-actions">
                <button onClick={() => patchStatus('active')}>启用</button>
                <button onClick={() => patchStatus('disabled')}>禁用</button>
                <button className="danger-button" onClick={deleteSelected}>
                  <Trash2 size={15} /> 删除
                </button>
              </div>
              <div className="role-profile-list">
                <h3>章节画像</h3>
                {(selectedAsset.profiles ?? []).map((profile) => (
                  <div key={profile.id} className="role-profile-card">
                    <strong>第 {profile.chapter_sort} 章</strong>
                    <span>{[profile.age, profile.gender, profile.appearance].filter(Boolean).join(' / ') || '未填写画像'}</span>
                    <button onClick={() => deleteProfile(profile.id)}>删除</button>
                  </div>
                ))}
              </div>
              <div className="role-profile-form">
                <input
                  value={profileForm.chapter_sort}
                  onChange={(event) => setProfileForm((current) => ({ ...current, chapter_sort: event.target.value }))}
                  placeholder="章节序号"
                />
                <input value={profileForm.age} onChange={(event) => setProfileForm((current) => ({ ...current, age: event.target.value }))} placeholder="年龄" />
                <input value={profileForm.gender} onChange={(event) => setProfileForm((current) => ({ ...current, gender: event.target.value }))} placeholder="性别" />
                <textarea
                  value={profileForm.appearance}
                  onChange={(event) => setProfileForm((current) => ({ ...current, appearance: event.target.value }))}
                  placeholder="章节外观描述"
                  rows={3}
                />
                <button onClick={addProfile} disabled={!profileForm.chapter_sort}>
                  <Plus size={15} /> 添加章节画像
                </button>
              </div>
            </>
          ) : (
            <div className="empty-detail">暂无角色底图记录</div>
          )}
        </div>
      </aside>
    </section>
  );
}
