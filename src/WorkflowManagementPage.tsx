import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Loader2, Plus, Save, Workflow } from 'lucide-react';

type ManagedWorkflowId = 'primary' | 'compare';
type WorkflowGroupStatus = 'active' | 'disabled';

interface ManagedWorkflowConfig {
  id: ManagedWorkflowId;
  group_id?: string;
  name: string;
  api_key?: string;
  console_url?: string;
  note?: string;
  created_at: string;
  updated_at: string;
}

interface ManagedWorkflowGroup {
  id: string;
  name: string;
  status: WorkflowGroupStatus;
  is_default: boolean;
  note?: string;
  workflows: ManagedWorkflowConfig[];
  created_at: string;
  updated_at: string;
}

interface WorkflowFormState {
  name: string;
  api_key: string;
  console_url: string;
  note: string;
}

interface GroupFormState {
  name: string;
  status: WorkflowGroupStatus;
  note: string;
}

const workflowLabel: Record<ManagedWorkflowId, string> = {
  primary: '主工作流',
  compare: '对照工作流'
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

function formFromWorkflow(workflow: ManagedWorkflowConfig): WorkflowFormState {
  return {
    name: workflow.name,
    api_key: workflow.api_key ?? '',
    console_url: workflow.console_url ?? '',
    note: workflow.note ?? ''
  };
}

function formFromGroup(group: ManagedWorkflowGroup): GroupFormState {
  return {
    name: group.name,
    status: group.status,
    note: group.note ?? ''
  };
}

function workflowFormKey(groupId: string, workflowId: ManagedWorkflowId) {
  return `${groupId}:${workflowId}`;
}

function normalizeGroupForms(groups: ManagedWorkflowGroup[]) {
  return Object.fromEntries(groups.map((group) => [group.id, formFromGroup(group)]));
}

function normalizeWorkflowForms(groups: ManagedWorkflowGroup[]) {
  return Object.fromEntries(groups.flatMap((group) => group.workflows.map((workflow) => [workflowFormKey(group.id, workflow.id), formFromWorkflow(workflow)])));
}

export function WorkflowManagementPage({ onSaved }: { onSaved?: () => void }) {
  const [groups, setGroups] = useState<ManagedWorkflowGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('default');
  const [groupForms, setGroupForms] = useState<Record<string, GroupFormState>>({});
  const [workflowForms, setWorkflowForms] = useState<Record<string, WorkflowFormState>>({});
  const [newGroup, setNewGroup] = useState({ id: '', name: '', note: '' });
  const [isLoading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? groups.find((group) => group.id === 'default') ?? groups[0],
    [groups, selectedGroupId]
  );

  async function loadGroups() {
    setLoading(true);
    setError('');
    try {
      const payload = await fetch('/api/workflow-groups').then((response) => readJson<{ groups: ManagedWorkflowGroup[] }>(response));
      setGroups(payload.groups);
      setGroupForms(normalizeGroupForms(payload.groups));
      setWorkflowForms(normalizeWorkflowForms(payload.groups));
      setSelectedGroupId((current) => (payload.groups.some((group) => group.id === current) ? current : payload.groups[0]?.id ?? 'default'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载 Workflow 分组失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadGroups();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function replaceGroup(nextGroup: ManagedWorkflowGroup) {
    setGroups((current) => current.map((group) => (group.id === nextGroup.id ? nextGroup : group)));
    setGroupForms((current) => ({ ...current, [nextGroup.id]: formFromGroup(nextGroup) }));
    setWorkflowForms((current) => ({
      ...current,
      ...Object.fromEntries(nextGroup.workflows.map((workflow) => [workflowFormKey(nextGroup.id, workflow.id), formFromWorkflow(workflow)]))
    }));
  }

  function updateGroupForm(groupId: string, patch: Partial<GroupFormState>) {
    setGroupForms((current) => ({
      ...current,
      [groupId]: {
        ...current[groupId],
        ...patch
      }
    }));
  }

  function updateWorkflowForm(groupId: string, workflowId: ManagedWorkflowId, patch: Partial<WorkflowFormState>) {
    const key = workflowFormKey(groupId, workflowId);
    setWorkflowForms((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch
      }
    }));
  }

  async function createGroup() {
    setSavingId('new-group');
    setError('');
    setMessage('');
    try {
      const payload = await fetch('/api/workflow-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newGroup)
      }).then((response) => readJson<{ group: ManagedWorkflowGroup }>(response));
      setGroups((current) => [payload.group, ...current]);
      setGroupForms((current) => ({ ...current, [payload.group.id]: formFromGroup(payload.group) }));
      setWorkflowForms((current) => ({
        ...current,
        ...Object.fromEntries(payload.group.workflows.map((workflow) => [workflowFormKey(payload.group.id, workflow.id), formFromWorkflow(workflow)]))
      }));
      setSelectedGroupId(payload.group.id);
      setNewGroup({ id: '', name: '', note: '' });
      setMessage(`分组 ${payload.group.name} 已创建`);
      onSaved?.();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建 Workflow 分组失败');
    } finally {
      setSavingId(null);
    }
  }

  async function saveGroup(group: ManagedWorkflowGroup) {
    const form = groupForms[group.id];
    if (!form) return;
    setSavingId(`group:${group.id}`);
    setError('');
    setMessage('');
    try {
      const payload = await fetch(`/api/workflow-groups/${group.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      }).then((response) => readJson<{ group: ManagedWorkflowGroup }>(response));
      replaceGroup(payload.group);
      setMessage(`分组 ${payload.group.name} 已保存`);
      onSaved?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存 Workflow 分组失败');
    } finally {
      setSavingId(null);
    }
  }

  async function saveWorkflow(group: ManagedWorkflowGroup, workflow: ManagedWorkflowConfig) {
    const form = workflowForms[workflowFormKey(group.id, workflow.id)];
    if (!form) return;
    setSavingId(`workflow:${group.id}:${workflow.id}`);
    setError('');
    setMessage('');
    try {
      const payload = await fetch(`/api/workflow-groups/${group.id}/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      }).then((response) => readJson<{ group: ManagedWorkflowGroup }>(response));
      replaceGroup(payload.group);
      setMessage(`${group.name} / ${workflowLabel[workflow.id]} 已保存`);
      onSaved?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存 Workflow 配置失败');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="workflow-management-page">
      <header className="workflow-management-header">
        <div>
          <span className="section-eyebrow">
            <Workflow size={16} />
            Workflow 管理
          </span>
          <h1>书籍库 Workflow 分组</h1>
          <p>每个分组固定包含主工作流和对照工作流。书籍库执行生图时选择分组，任务会绑定该分组后再调用双工作流。</p>
        </div>
      </header>

      {error && <div className="inline-error">{error}</div>}
      {message && <div className="inline-success">{message}</div>}

      {isLoading ? (
        <div className="empty-detail">
          <Loader2 className="spin" size={18} />
          正在加载 Workflow 分组
        </div>
      ) : (
        <div className="workflow-group-layout">
          <aside className="workflow-group-sidebar">
            <form
              className="workflow-group-create"
              onSubmit={(event) => {
                event.preventDefault();
                void createGroup();
              }}
            >
              <strong>新增分组</strong>
              <input placeholder="分组 ID，例如 hu-v2" value={newGroup.id} onChange={(event) => setNewGroup((current) => ({ ...current, id: event.target.value }))} />
              <input placeholder="分组名称" value={newGroup.name} onChange={(event) => setNewGroup((current) => ({ ...current, name: event.target.value }))} />
              <textarea placeholder="分组备注" value={newGroup.note} onChange={(event) => setNewGroup((current) => ({ ...current, note: event.target.value }))} />
              <button disabled={savingId === 'new-group'}>
                {savingId === 'new-group' ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                创建分组
              </button>
            </form>

            <div className="workflow-group-list">
              {groups.map((group) => (
                <button
                  key={group.id}
                  className={selectedGroup?.id === group.id ? 'active' : ''}
                  onClick={() => setSelectedGroupId(group.id)}
                  type="button"
                >
                  <strong>{group.name}</strong>
                  <span>{group.id}</span>
                  <small>{group.is_default ? '默认分组' : group.status === 'active' ? 'active' : 'disabled'}</small>
                </button>
              ))}
            </div>
          </aside>

          {selectedGroup && (
            <section className="workflow-group-detail">
              <article className="workflow-group-card">
                <div className="workflow-card-title">
                  <div>
                    <span>当前分组</span>
                    <strong>{selectedGroup.name}</strong>
                  </div>
                  <button className="secondary-action" onClick={() => void navigator.clipboard?.writeText(selectedGroup.id)}>
                    <Copy size={14} />
                    复制 ID
                  </button>
                </div>
                <div className="workflow-group-meta">
                  <code>{selectedGroup.id}</code>
                  <span>{selectedGroup.is_default ? '默认分组，不可禁用' : '可禁用；禁用后不影响历史任务展示'}</span>
                </div>
                <div className="workflow-group-form">
                  <label>
                    分组名称
                    <input value={groupForms[selectedGroup.id]?.name ?? ''} onChange={(event) => updateGroupForm(selectedGroup.id, { name: event.target.value })} />
                  </label>
                  <label>
                    分组状态
                    <select
                      value={groupForms[selectedGroup.id]?.status ?? selectedGroup.status}
                      disabled={selectedGroup.is_default}
                      onChange={(event) => updateGroupForm(selectedGroup.id, { status: event.target.value as WorkflowGroupStatus })}
                    >
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </label>
                  <label>
                    分组备注
                    <textarea value={groupForms[selectedGroup.id]?.note ?? ''} onChange={(event) => updateGroupForm(selectedGroup.id, { note: event.target.value })} />
                  </label>
                </div>
                <button className="workflow-save-button" onClick={() => void saveGroup(selectedGroup)} disabled={savingId === `group:${selectedGroup.id}`}>
                  {savingId === `group:${selectedGroup.id}` ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                  保存分组
                </button>
              </article>

              <div className="workflow-config-grid">
                {selectedGroup.workflows.map((workflow) => {
                  const form = workflowForms[workflowFormKey(selectedGroup.id, workflow.id)] ?? formFromWorkflow(workflow);
                  const savingWorkflowId = `workflow:${selectedGroup.id}:${workflow.id}`;
                  return (
                    <article className="workflow-config-card" key={workflow.id}>
                      <div className="workflow-card-title">
                        <div>
                          <span>{workflowLabel[workflow.id]}</span>
                          <strong>{workflow.name}</strong>
                        </div>
                        {form.console_url && (
                          <a href={form.console_url} target="_blank" rel="noreferrer" title="打开 Dify 控制台地址">
                            <ExternalLink size={16} />
                          </a>
                        )}
                      </div>

                      <label>
                        工作流名称
                        <input value={form.name} onChange={(event) => updateWorkflowForm(selectedGroup.id, workflow.id, { name: event.target.value })} />
                      </label>
                      <label>
                        API key
                        <input value={form.api_key} onChange={(event) => updateWorkflowForm(selectedGroup.id, workflow.id, { api_key: event.target.value })} />
                      </label>
                      <label>
                        Dify 控制台地址
                        <input
                          placeholder="https://dify.example/app/..."
                          value={form.console_url}
                          onChange={(event) => updateWorkflowForm(selectedGroup.id, workflow.id, { console_url: event.target.value })}
                        />
                      </label>
                      <label>
                        工作流备注
                        <textarea value={form.note} onChange={(event) => updateWorkflowForm(selectedGroup.id, workflow.id, { note: event.target.value })} />
                      </label>

                      <div className="workflow-card-footer">
                        <small>最后更新：{new Date(workflow.updated_at).toLocaleString()}</small>
                        <button onClick={() => void saveWorkflow(selectedGroup, workflow)} disabled={savingId === savingWorkflowId}>
                          {savingId === savingWorkflowId ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                          保存配置
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
