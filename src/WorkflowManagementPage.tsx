import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Save, Workflow } from 'lucide-react';

type ManagedWorkflowId = 'primary' | 'compare';

interface ManagedWorkflowConfig {
  id: ManagedWorkflowId;
  name: string;
  api_key?: string;
  console_url?: string;
  note?: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowFormState {
  name: string;
  api_key: string;
  console_url: string;
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

export function WorkflowManagementPage({ onSaved }: { onSaved?: () => void }) {
  const [workflows, setWorkflows] = useState<ManagedWorkflowConfig[]>([]);
  const [forms, setForms] = useState<Record<string, WorkflowFormState>>({});
  const [isLoading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let ignore = false;

    fetch('/api/workflows')
      .then((response) => readJson<{ workflows: ManagedWorkflowConfig[] }>(response))
      .then((payload) => {
        if (ignore) return;
        setWorkflows(payload.workflows);
        setForms(Object.fromEntries(payload.workflows.map((workflow) => [workflow.id, formFromWorkflow(workflow)])));
      })
      .catch((loadError) => {
        if (ignore) return;
        setError(loadError instanceof Error ? loadError.message : '加载 Workflow 配置失败');
      })
      .finally(() => {
        if (ignore) return;
        setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

  function updateForm(id: ManagedWorkflowId, patch: Partial<WorkflowFormState>) {
    setForms((current) => ({
      ...current,
      [id]: {
        ...current[id],
        ...patch
      }
    }));
  }

  async function saveWorkflow(workflow: ManagedWorkflowConfig) {
    const form = forms[workflow.id];
    if (!form) return;
    setSavingId(workflow.id);
    setError('');
    setMessage('');
    try {
      const payload = await fetch(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      }).then((response) => readJson<{ workflow: ManagedWorkflowConfig }>(response));
      setWorkflows((current) => current.map((item) => (item.id === payload.workflow.id ? payload.workflow : item)));
      setForms((current) => ({ ...current, [payload.workflow.id]: formFromWorkflow(payload.workflow) }));
      setMessage(`${workflowLabel[payload.workflow.id]}已保存`);
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
          <h1>书籍库双工作流配置</h1>
          <p>管理主工作流与对照工作流的名称、API key、Dify 控制台地址和备注。保存后会影响后续书籍库生图调用。</p>
        </div>
      </header>

      {error && <div className="inline-error">{error}</div>}
      {message && <div className="inline-success">{message}</div>}

      {isLoading ? (
        <div className="empty-detail">
          <Loader2 className="spin" size={18} />
          正在加载 Workflow 配置
        </div>
      ) : (
        <div className="workflow-config-grid">
          {workflows.map((workflow) => {
            const form = forms[workflow.id] ?? formFromWorkflow(workflow);
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
                  <input value={form.name} onChange={(event) => updateForm(workflow.id, { name: event.target.value })} />
                </label>
                <label>
                  API key
                  <input value={form.api_key} onChange={(event) => updateForm(workflow.id, { api_key: event.target.value })} />
                </label>
                <label>
                  Dify 控制台地址
                  <input
                    placeholder="https://dify.example/app/..."
                    value={form.console_url}
                    onChange={(event) => updateForm(workflow.id, { console_url: event.target.value })}
                  />
                </label>
                <label>
                  工作流备注
                  <textarea value={form.note} onChange={(event) => updateForm(workflow.id, { note: event.target.value })} />
                </label>

                <div className="workflow-card-footer">
                  <small>最后更新：{new Date(workflow.updated_at).toLocaleString()}</small>
                  <button onClick={() => void saveWorkflow(workflow)} disabled={savingId === workflow.id}>
                    {savingId === workflow.id ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                    保存配置
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
