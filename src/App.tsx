import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react';

type RequiredInputKey = 'book_id' | 'paragraph_content' | 'chapter_sort';
type Mapping = Record<RequiredInputKey, string>;
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';

interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
  previewRows: Record<string, unknown>[];
  rowCount: number;
  autoMapping: Partial<Mapping>;
}

interface ParsedWorkbook {
  id: string;
  fileName: string;
  sheets: ParsedSheet[];
  createdAt: string;
}

interface ResultFile {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  previewUrl: string;
  remoteUrl?: string;
}

interface BatchTask {
  id: string;
  row_no: number;
  input: {
    book_id: number;
    paragraph_content: string;
    chapter_sort: number;
  };
  status: TaskStatus;
  attempts: number;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds?: number;
  workflow_run_id?: string;
  dify_task_id?: string;
  progress_percent?: number;
  progress_label?: string;
  pause_reason?: 'batch' | 'task' | 'stop';
  stop_requested_at?: string;
  role?: string[];
  title?: string;
  result_files: ResultFile[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

interface BatchEvent {
  id: string;
  type: 'info' | 'error' | 'task' | 'export';
  message: string;
  createdAt: string;
  taskId?: string;
}

interface LarkExportResult {
  baseToken?: string;
  baseUrl?: string;
  tableId?: string;
  tableName: string;
  createdAt: string;
  recordsCreated: number;
  attachmentsUploaded: number;
}

interface Batch {
  id: string;
  workbookId: string;
  sheetName: string;
  fileName: string;
  mapping: Mapping;
  status: 'idle' | 'running' | 'paused' | 'completed';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pauseRequested: boolean;
  export?: LarkExportResult;
  tasks: BatchTask[];
  events: BatchEvent[];
}

const REQUIRED_FIELDS: Array<{ key: RequiredInputKey; label: string; hint: string }> = [
  { key: 'book_id', label: '书籍 ID', hint: 'number' },
  { key: 'paragraph_content', label: '段落内容', hint: 'paragraph' },
  { key: 'chapter_sort', label: '章节序号', hint: 'number' }
];

const statusLabel: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  paused: '已暂停'
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `请求失败：${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function truncate(text: string, length = 120) {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function absolutePreviewUrl(url: string) {
  return url.startsWith('http') ? url : url;
}

function statusIcon(status: TaskStatus) {
  if (status === 'succeeded') return <CheckCircle2 size={16} />;
  if (status === 'failed') return <XCircle size={16} />;
  if (status === 'running') return <Loader2 size={16} className="spin" />;
  if (status === 'paused') return <Pause size={16} />;
  return <RefreshCw size={16} />;
}

export function App() {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [mapping, setMapping] = useState<Partial<Mapping>>({});
  const [batch, setBatch] = useState<Batch | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxFile, setLightboxFile] = useState<ResultFile | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedSheet = useMemo(
    () => workbook?.sheets.find((sheet) => sheet.name === selectedSheetName) ?? null,
    [selectedSheetName, workbook]
  );

  const selectedTask = useMemo(
    () => batch?.tasks.find((task) => task.id === selectedTaskId) ?? batch?.tasks.find((task) => task.status !== 'queued') ?? batch?.tasks[0],
    [batch, selectedTaskId]
  );

  const stats = useMemo(() => {
    const tasks = batch?.tasks ?? [];
    return {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      running: tasks.filter((task) => task.status === 'running').length,
      succeeded: tasks.filter((task) => task.status === 'succeeded').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      paused: tasks.filter((task) => task.status === 'paused').length
    };
  }, [batch]);

  useEffect(() => {
    const lastBatchId = localStorage.getItem('dify-batch:lastBatchId');
    if (!lastBatchId) return;
    fetch(`/api/batches/${lastBatchId}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload) => {
        if (payload) setBatch(payload);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!batch?.id) return;
    localStorage.setItem('dify-batch:lastBatchId', batch.id);
    const source = new EventSource(`/api/batches/${batch.id}/events`);
    source.onmessage = (event) => {
      setBatch(JSON.parse(event.data));
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [batch?.id]);

  async function uploadWorkbook(file: File) {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const nextWorkbook = await fetch('/api/workbooks', {
        method: 'POST',
        body: form
      }).then((response) => readJson<ParsedWorkbook>(response));
      setWorkbook(nextWorkbook);
      const firstSheet = nextWorkbook.sheets[0];
      setSelectedSheetName(firstSheet?.name ?? '');
      setMapping(firstSheet?.autoMapping ?? {});
      setBatch(null);
      setSelectedTaskId(null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function createBatchFromMapping() {
    if (!workbook || !selectedSheet) return;
    setError(null);
    setCreating(true);
    try {
      const missing = REQUIRED_FIELDS.filter((field) => !mapping[field.key]);
      if (missing.length > 0) {
        throw new Error(`请先完成字段映射：${missing.map((item) => item.label).join('、')}`);
      }
      const nextBatch = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workbookId: workbook.id,
          sheetName: selectedSheet.name,
          mapping
        })
      }).then((response) => readJson<Batch>(response));
      setBatch(nextBatch);
      setSelectedTaskId(nextBatch.tasks[0]?.id ?? null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建批次失败');
    } finally {
      setCreating(false);
    }
  }

  async function batchAction(action: 'start' | 'pause' | 'retry-failed') {
    if (!batch) return;
    setError(null);
    try {
      const nextBatch = await fetch(`/api/batches/${batch.id}/${action}`, {
        method: 'POST'
      }).then((response) => readJson<Batch>(response));
      setBatch(nextBatch);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
    }
  }

  async function taskAction(task: BatchTask, action: 'pause' | 'retry' | 'delete') {
    if (!batch) return;
    setError(null);
    try {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const suffix = action === 'delete' ? '' : `/${action}`;
      const nextBatch = await fetch(`/api/batches/${batch.id}/tasks/${task.id}${suffix}`, {
        method
      }).then((response) => readJson<Batch>(response));
      setBatch(nextBatch);
      if (action === 'delete' && selectedTaskId === task.id) {
        setSelectedTaskId(nextBatch.tasks[0]?.id ?? null);
      }
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : '任务操作失败');
    }
  }

  async function exportToLark() {
    if (!batch) return;
    setError(null);
    setExporting(true);
    try {
      const result = await fetch(`/api/batches/${batch.id}/export/lark`, {
        method: 'POST'
      }).then((response) => readJson<LarkExportResult>(response));
      setBatch({ ...batch, export: result });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出飞书失败');
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>Dify Excel 批量工作流</h1>
          <p>上传表格，映射字段，串行执行工作流，并把结果导出到飞书多维表格。</p>
        </div>
        <button className="primary-action" onClick={() => inputRef.current?.click()} disabled={isUploading}>
          {isUploading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
          上传 Excel
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadWorkbook(file);
            event.currentTarget.value = '';
          }}
        />
      </section>

      {error && (
        <section className="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </section>
      )}

      <section className="layout-grid">
        <aside className="left-panel">
          <div className="panel-section upload-card">
            <div className="panel-heading">
              <FileSpreadsheet size={18} />
              <span>工作簿</span>
            </div>
            {workbook ? (
              <>
                <div className="file-name">{workbook.fileName}</div>
                <label className="field-label">
                  工作表
                  <select
                    value={selectedSheetName}
                    onChange={(event) => {
                      const sheet = workbook.sheets.find((item) => item.name === event.target.value);
                      setSelectedSheetName(event.target.value);
                      setMapping(sheet?.autoMapping ?? {});
                    }}
                  >
                    {workbook.sheets.map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} · {sheet.rowCount} 行
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <button className="drop-button" onClick={() => inputRef.current?.click()}>
                <Upload size={22} />
                选择 Excel 或 CSV
              </button>
            )}
          </div>

          <div className="panel-section">
            <div className="panel-heading">
              <Database size={18} />
              <span>字段映射</span>
            </div>
            {selectedSheet ? (
              <div className="mapping-list">
                {REQUIRED_FIELDS.map((field) => (
                  <label className="field-label" key={field.key}>
                    <span>
                      {field.label}
                      <small>{field.hint}</small>
                    </span>
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}
                    >
                      <option value="">选择列</option>
                      {selectedSheet.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <button className="wide-button" onClick={() => void createBatchFromMapping()} disabled={isCreating}>
                  {isCreating ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  编译任务列表
                </button>
              </div>
            ) : (
              <p className="muted">上传文件后自动识别列名。</p>
            )}
          </div>

          <div className="panel-section">
            <div className="panel-heading">
              <Play size={18} />
              <span>执行控制</span>
            </div>
            <div className="control-grid">
              <button disabled={!batch || batch.status === 'running'} onClick={() => void batchAction('start')}>
                <Play size={16} />
                开始
              </button>
              <button disabled={!batch || batch.status !== 'running'} onClick={() => void batchAction('pause')}>
                <Pause size={16} />
                暂停
              </button>
              <button disabled={!batch || stats.failed === 0 || batch.status === 'running'} onClick={() => void batchAction('retry-failed')}>
                <RefreshCw size={16} />
                重试失败
              </button>
              <button disabled={!batch || isExporting} onClick={() => void exportToLark()}>
                {isExporting ? <Loader2 className="spin" size={16} /> : <Database size={16} />}
                导出飞书
              </button>
            </div>
            {batch?.export && (
              <a className="export-link" href={batch.export.baseUrl} target="_blank" rel="noreferrer">
                飞书 Base：{batch.export.recordsCreated} 行，{batch.export.attachmentsUploaded} 个附件
              </a>
            )}
          </div>
        </aside>

        <section className="main-panel">
          <div className="stats-row">
            <Stat label="全部" value={stats.total} />
            <Stat label="排队" value={stats.queued + stats.paused} />
            <Stat label="执行中" value={stats.running} />
            <Stat label="成功" value={stats.succeeded} tone="success" />
            <Stat label="失败" value={stats.failed} tone="danger" />
          </div>

          {batch ? (
            <div className="task-table-wrap">
              <table className="task-table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>图片</th>
                    <th>行号</th>
                    <th>书籍 ID</th>
                    <th>章节</th>
                    <th>进度</th>
                    <th>段落内容</th>
                    <th>标题</th>
                    <th>耗时</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.tasks.map((task) => (
                    <tr
                      key={task.id}
                      className={selectedTask?.id === task.id ? 'selected' : ''}
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <td>
                        <span className={`status-pill ${task.status}`}>
                          {statusIcon(task.status)}
                          {statusLabel[task.status]}
                        </span>
                      </td>
                      <td>
                        {task.result_files[0] ? (
                          <button
                            className="thumb-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedTaskId(task.id);
                              setLightboxFile(task.result_files[0]);
                            }}
                            title="查看大图"
                          >
                            <img src={absolutePreviewUrl(task.result_files[0].previewUrl)} alt={task.result_files[0].name} />
                          </button>
                        ) : (
                          <span className="thumb-empty">-</span>
                        )}
                      </td>
                      <td>{task.row_no}</td>
                      <td>{task.input.book_id || '-'}</td>
                      <td>{task.input.chapter_sort || '-'}</td>
                      <td>
                        <ProgressCell task={task} />
                      </td>
                      <td>{truncate(task.input.paragraph_content, 80)}</td>
                      <td>{task.title || '-'}</td>
                      <td>{task.elapsed_seconds ? `${task.elapsed_seconds}s` : '-'}</td>
                      <td>
                        <TaskActions task={task} onAction={(action) => void taskAction(task, action)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : selectedSheet ? (
            <div className="preview-card">
              <h2>上传预览</h2>
              <div className="preview-table-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      {selectedSheet.headers.slice(0, 6).map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedSheet.previewRows.map((row, index) => (
                      <tr key={index}>
                        {selectedSheet.headers.slice(0, 6).map((header) => (
                          <td key={header}>{truncate(String(row[header] ?? ''), 48)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <FileSpreadsheet size={40} />
              <h2>从 Excel 开始</h2>
              <p>表头可使用 `book_id`、`paragraph_content`、`chapter_sort`，也支持中文列名自动匹配。</p>
            </div>
          )}
        </section>

        <aside className="right-panel">
          <div className="panel-section result-panel">
            <div className="panel-heading">
              <ImageIcon size={18} />
              <span>结果预览</span>
            </div>
            {selectedTask ? (
              <div className="result-body">
                <div className={`status-pill ${selectedTask.status}`}>
                  {statusIcon(selectedTask.status)}
                  第 {selectedTask.row_no} 行 · {statusLabel[selectedTask.status]}
                </div>
                <ProgressCell task={selectedTask} wide />
                <h2>{selectedTask.title || '暂无标题'}</h2>
                <p className="muted">角色：{selectedTask.role?.join('、') || '-'}</p>
                {selectedTask.result_files.length > 0 ? (
                  <div className="image-grid">
                    {selectedTask.result_files.map((file) => (
                      <button className="image-preview-button" onClick={() => setLightboxFile(file)} key={file.id}>
                        <img src={absolutePreviewUrl(file.previewUrl)} alt={file.name} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="image-placeholder">
                    <ImageIcon size={24} />
                    暂无图片
                  </div>
                )}
                {selectedTask.result_text && <pre className="text-output">{selectedTask.result_text}</pre>}
                {selectedTask.error && (
                  <div className="task-error">
                    <AlertCircle size={16} />
                    {selectedTask.error}
                  </div>
                )}
              </div>
            ) : (
              <p className="muted">执行后可查看每行结果。</p>
            )}
          </div>

          <div className="panel-section event-panel">
            <div className="panel-heading">
              <RefreshCw size={18} />
              <span>运行日志</span>
            </div>
            <div className="event-list">
              {(batch?.events ?? []).slice(0, 5).map((event) => (
                <div className={`event-item ${event.type}`} key={event.id}>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <span>{event.message}</span>
                </div>
              ))}
              {!batch && <p className="muted">还没有任务日志。</p>}
            </div>
          </div>
        </aside>
      </section>

      {lightboxFile && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setLightboxFile(null)}>
          <div className="lightbox-content" onClick={(event) => event.stopPropagation()}>
            <div className="lightbox-toolbar">
              <span>{lightboxFile.name}</span>
              <div>
                <a href={absolutePreviewUrl(lightboxFile.previewUrl)} target="_blank" rel="noreferrer">
                  新窗口打开
                </a>
                <button onClick={() => setLightboxFile(null)}>关闭</button>
              </div>
            </div>
            <img src={absolutePreviewUrl(lightboxFile.previewUrl)} alt={lightboxFile.name} />
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <div className={`stat-card ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProgressCell({ task, wide = false }: { task: BatchTask; wide?: boolean }) {
  const percent =
    task.status === 'succeeded'
      ? 100
      : task.status === 'queued' || task.status === 'paused'
        ? 0
        : Math.max(0, Math.min(100, task.progress_percent ?? (task.status === 'running' ? 8 : 0)));
  const label = task.progress_label ?? (task.status === 'running' ? '执行中' : statusLabel[task.status]);

  return (
    <div className={`progress-cell ${wide ? 'wide' : ''}`}>
      <div className="progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>{label}</small>
    </div>
  );
}

function TaskActions({ task, onAction }: { task: BatchTask; onAction: (action: 'pause' | 'retry' | 'delete') => void }) {
  const validationFailed = task.error?.startsWith('字段校验失败') ?? false;
  const canPause = task.status === 'queued' || task.status === 'running';
  const canRetry = ['failed', 'paused', 'succeeded'].includes(task.status) && !validationFailed;
  const deletingLabel = task.status === 'running' ? '停止并删除' : '删除';

  return (
    <div className="task-actions" onClick={(event) => event.stopPropagation()}>
      <button title="暂停任务" disabled={!canPause} onClick={() => onAction('pause')}>
        <Pause size={14} />
      </button>
      <button title="重试任务" disabled={!canRetry} onClick={() => onAction('retry')}>
        <RefreshCw size={14} />
      </button>
      <button title={deletingLabel} onClick={() => onAction('delete')}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}
