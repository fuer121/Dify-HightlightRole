import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Database,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react';

type RequiredInputKey = 'book_id' | 'paragraph_content' | 'chapter_sort';
type Mapping = Record<RequiredInputKey, string>;
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';
type StatusFilter = TaskStatus | 'all';
type AppPage = 'batch' | 'quality';
type ImageValue = '有价值' | '无价值';
type QualityRunStatus = 'idle' | 'running' | 'completed' | 'failed';

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
  is_valid?: unknown;
  paragraph_description?: string;
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
  rowLimit?: number;
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

interface QualityPromptVersion {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  parentId?: string;
  calibrationSummary?: string;
  sampleCount?: number;
}

interface QualityJudgment {
  promptVersionId: string;
  status: QualityRunStatus;
  startedAt?: string;
  finishedAt?: string;
  elapsedSeconds?: number;
  workflowRunId?: string;
  taskId?: string;
  is_valid?: number;
  score?: number;
  image_value?: ImageValue;
  recommendation?: string;
  visual_elements: string[];
  non_visual_elements: string[];
  reason?: string;
  calibration_note?: string;
  judgment_report?: string;
  raw_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

interface QualityAnnotation {
  expectedImageValue: ImageValue;
  note?: string;
  updatedAt: string;
}

interface QualityRecord {
  id: string;
  row_no: number;
  paragraph_content: string;
  judgments: Record<string, QualityJudgment>;
  annotation?: QualityAnnotation;
}

interface QualityEvent {
  id: string;
  type: 'info' | 'error' | 'task' | 'calibration';
  message: string;
  createdAt: string;
  recordId?: string;
}

interface QualityExperiment {
  id: string;
  workbookId: string;
  sheetName: string;
  fileName: string;
  paragraphColumn: string;
  rowLimit?: number;
  promptVersionIds: string[];
  status: QualityRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  records: QualityRecord[];
  events: QualityEvent[];
}

interface QualityExperimentSummary {
  id: string;
  fileName: string;
  sheetName: string;
  paragraphColumn: string;
  rowLimit?: number;
  status: QualityRunStatus;
  recordCount: number;
  judgedCount: number;
  annotatedCount: number;
  promptVersionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface QualityState {
  activePromptVersionId: string;
  promptVersions: QualityPromptVersion[];
  experiments: QualityExperimentSummary[];
}

interface PromptPopoverState {
  version: QualityPromptVersion;
  top: number;
  left: number;
  placement: 'left' | 'right';
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

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'queued', label: statusLabel.queued },
  { value: 'running', label: statusLabel.running },
  { value: 'succeeded', label: statusLabel.succeeded },
  { value: 'failed', label: statusLabel.failed },
  { value: 'paused', label: statusLabel.paused }
];

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

function isValidationFailed(task: BatchTask) {
  return task.error?.startsWith('字段校验失败') ?? false;
}

function canGenerateTask(task: BatchTask) {
  return task.status !== 'running' && !isValidationFailed(task);
}

function looksLikeMojibake(text: string) {
  return !/[\u3400-\u9fff]/.test(text) && (text.match(/[ÃÂâåæçèéäöü]/g)?.length ?? 0) >= 2;
}

function normalizeDisplayFileName(fileName: string) {
  if (!looksLikeMojibake(fileName)) return fileName;
  try {
    const bytes = Uint8Array.from([...fileName].map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u3400-\u9fff]/.test(decoded) ? decoded : fileName;
  } catch {
    return fileName;
  }
}

export function App() {
  const initialPage = new URLSearchParams(window.location.search).get('page') === 'quality' ? 'quality' : 'batch';
  const [page, setPage] = useState<AppPage>(initialPage);

  function updatePage(nextPage: AppPage) {
    setPage(nextPage);
    const url = new URL(window.location.href);
    if (nextPage === 'quality') {
      url.searchParams.set('page', 'quality');
    } else {
      url.searchParams.delete('page');
    }
    window.history.replaceState({}, '', url);
  }

  return (
    <main className="app-shell">
      <AppNav page={page} onChange={updatePage} />
      {page === 'quality' ? <QualityPromptPage /> : <BatchWorkflowPage />}
    </main>
  );
}

function AppNav({ page, onChange }: { page: AppPage; onChange: (page: AppPage) => void }) {
  return (
    <nav className="app-nav">
      <div>
        <strong>Dify Excel 工具台</strong>
        <span>批量生图与质量判断 Prompt 优化</span>
      </div>
      <div className="nav-tabs">
        <button className={page === 'batch' ? 'active' : ''} onClick={() => onChange('batch')}>
          <ImageIcon size={16} />
          批量生图
        </button>
        <button className={page === 'quality' ? 'active' : ''} onClick={() => onChange('quality')}>
          <SlidersHorizontal size={16} />
          质量判断
        </button>
      </div>
    </nav>
  );
}

function BatchWorkflowPage() {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [mapping, setMapping] = useState<Partial<Mapping>>({});
  const [rowLimit, setRowLimit] = useState('');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [isUploading, setUploading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [isStartingSelected, setStartingSelected] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [isEventLogOpen, setEventLogOpen] = useState(false);
  const [isSetupPanelOpen, setSetupPanelOpen] = useState(true);
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

  const rowLimitValue = rowLimit.trim();
  const effectiveRowLimit =
    selectedSheet && rowLimitValue ? Math.min(Math.max(Number(rowLimitValue) || 0, 0), selectedSheet.rowCount) : selectedSheet?.rowCount ?? 0;

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

  const bookIdOptions = useMemo(() => {
    const ids = new Set((batch?.tasks ?? []).map((task) => task.input.book_id).filter((value) => Number.isFinite(value)));
    return Array.from(ids).sort((a, b) => a - b);
  }, [batch]);

  const filteredTasks = useMemo(() => {
    const tasks = batch?.tasks ?? [];
    return tasks.filter((task) => {
      const matchesBook = selectedBookId === 'all' || String(task.input.book_id) === selectedBookId;
      const matchesStatus = statusFilter === 'all' || task.status === statusFilter;
      return matchesBook && matchesStatus;
    });
  }, [batch, selectedBookId, statusFilter]);

  const visibleGeneratableTasks = useMemo(() => filteredTasks.filter(canGenerateTask), [filteredTasks]);

  const selectedVisibleTaskIds = useMemo(
    () => visibleGeneratableTasks.filter((task) => selectedTaskIds.has(task.id)).map((task) => task.id),
    [selectedTaskIds, visibleGeneratableTasks]
  );

  const generateTargetIds = useMemo(
    () => (selectedVisibleTaskIds.length > 0 ? selectedVisibleTaskIds : visibleGeneratableTasks.map((task) => task.id)),
    [selectedVisibleTaskIds, visibleGeneratableTasks]
  );
  const allVisibleSelected =
    visibleGeneratableTasks.length > 0 && visibleGeneratableTasks.every((task) => selectedTaskIds.has(task.id));
  const someVisibleSelected = visibleGeneratableTasks.some((task) => selectedTaskIds.has(task.id));

  useEffect(() => {
    const lastBatchId = localStorage.getItem('dify-batch:lastBatchId');
    if (!lastBatchId) return;
    fetch(`/api/batches/${lastBatchId}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload) => {
        if (payload) {
          setBatch(payload);
          setSetupPanelOpen(false);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const batchId = params.get('batchId');
    if (!batchId) return;
    fetch(`/api/batches/${batchId}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload) => {
        if (payload) {
          setBatch(payload);
          setSetupPanelOpen(false);
        }
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
      setRowLimit('');
      setBatch(null);
      setSelectedTaskId(null);
      setSelectedBookId('all');
      setStatusFilter('all');
      setSelectedTaskIds(new Set());
      setSetupPanelOpen(true);
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
      let parsedRowLimit: number | undefined;
      if (rowLimitValue) {
        parsedRowLimit = Number(rowLimitValue);
        if (!Number.isInteger(parsedRowLimit) || parsedRowLimit < 1) {
          throw new Error('入队行数必须是大于 0 的整数');
        }
        if (parsedRowLimit > selectedSheet.rowCount) {
          throw new Error(`入队行数不能超过当前工作表 ${selectedSheet.rowCount} 行`);
        }
      }
      const nextBatch = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workbookId: workbook.id,
          sheetName: selectedSheet.name,
          mapping,
          rowLimit: parsedRowLimit
        })
      }).then((response) => readJson<Batch>(response));
      setBatch(nextBatch);
      setSelectedTaskId(nextBatch.tasks[0]?.id ?? null);
      setSelectedBookId('all');
      setStatusFilter('all');
      setSelectedTaskIds(new Set());
      setSetupPanelOpen(false);
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

  async function startSelectedTasks() {
    if (!batch || generateTargetIds.length === 0) return;
    setError(null);
    setStartingSelected(true);
    try {
      const nextBatch = await fetch(`/api/batches/${batch.id}/start-selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: generateTargetIds })
      }).then((response) => readJson<Batch>(response));
      setBatch(nextBatch);
      setSelectedTaskIds(new Set());
      setSelectedTaskId((current) => current ?? nextBatch.tasks.find((task) => generateTargetIds.includes(task.id))?.id ?? nextBatch.tasks[0]?.id ?? null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '启动选中任务失败');
    } finally {
      setStartingSelected(false);
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

  function updateBookFilter(value: string) {
    setSelectedBookId(value);
    setSelectedTaskIds(new Set());
  }

  function updateStatusFilter(value: StatusFilter) {
    setStatusFilter(value);
    setSelectedTaskIds(new Set());
  }

  function toggleVisibleSelection() {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleGeneratableTasks.forEach((task) => next.delete(task.id));
      } else {
        visibleGeneratableTasks.forEach((task) => next.add(task.id));
      }
      return next;
    });
  }

  function toggleTaskSelection(task: BatchTask) {
    if (!canGenerateTask(task) || batch?.status === 'running') return;
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(task.id)) {
        next.delete(task.id);
      } else {
        next.add(task.id);
      }
      return next;
    });
  }

  return (
    <>
      <section className="topbar">
        <div>
          <h1>Dify Excel 批量工作流</h1>
          <p>上传表格，映射字段，串行执行工作流，并把结果导出到飞书多维表格。</p>
        </div>
        <div className="topbar-actions">
          <button className="secondary-action" type="button" onClick={() => setSetupPanelOpen((current) => !current)}>
            {isSetupPanelOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            {isSetupPanelOpen ? '收起配置' : '展开配置'}
          </button>
          <button className="primary-action" onClick={() => inputRef.current?.click()} disabled={isUploading}>
            {isUploading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            上传 Excel
          </button>
        </div>
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

      <section className={`layout-grid batch-layout ${isSetupPanelOpen ? '' : 'setup-collapsed'}`}>
        <aside className={`left-panel batch-left ${isSetupPanelOpen ? '' : 'collapsed'}`}>
          {isSetupPanelOpen ? (
            <>
              <div className="panel-section setup-panel-title">
                <div className="panel-heading">
                  <SlidersHorizontal size={18} />
                  <span>批量配置</span>
                  <button type="button" className="icon-ghost-button" onClick={() => setSetupPanelOpen(false)} title="收起配置栏">
                    <PanelLeftClose size={16} />
                  </button>
                </div>
                <p className="muted">上传、映射、编译和执行控制集中在这里；创建批次后会自动收起。</p>
              </div>

              <div className="panel-section upload-card">
                <div className="panel-heading">
                  <FileSpreadsheet size={18} />
                  <span>工作簿</span>
                </div>
                {workbook ? (
                  <>
                    <div className="file-name">{normalizeDisplayFileName(workbook.fileName)}</div>
                    <label className="field-label">
                      工作表
                      <select
                        value={selectedSheetName}
                        onChange={(event) => {
                          const sheet = workbook.sheets.find((item) => item.name === event.target.value);
                          setSelectedSheetName(event.target.value);
                          setMapping(sheet?.autoMapping ?? {});
                          setRowLimit('');
                        }}
                      >
                        {workbook.sheets.map((sheet) => (
                          <option key={sheet.name} value={sheet.name}>
                            {sheet.name} · {sheet.rowCount} 行
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      <span>
                        入队行数
                        <small>默认全部</small>
                      </span>
                      <input
                        min="1"
                        max={selectedSheet?.rowCount}
                        type="number"
                        inputMode="numeric"
                        placeholder={selectedSheet ? `全部 ${selectedSheet.rowCount} 行` : '全部'}
                        value={rowLimit}
                        onChange={(event) => setRowLimit(event.target.value)}
                      />
                      {selectedSheet && (
                        <span className="field-hint">
                          将编译前 {effectiveRowLimit || selectedSheet.rowCount} 行进入生图队列
                        </span>
                      )}
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
            </>
          ) : (
            <div className="setup-rail">
              <button className="setup-rail-button" type="button" onClick={() => setSetupPanelOpen(true)} title="展开配置栏">
                <PanelLeftOpen size={18} />
                <span>配置</span>
              </button>
              <div className="rail-status">
                <strong>{stats.total || selectedSheet?.rowCount || 0}</strong>
                <span>{batch ? '任务' : '行'}</span>
              </div>
              <div className="rail-icons" aria-label="批量流程状态">
                <FileSpreadsheet size={16} />
                <Database size={16} />
                <Play size={16} />
              </div>
            </div>
          )}
        </aside>

        <section className="main-panel batch-main">
          <div className="stats-row batch-stats">
            <Stat label="全部" value={stats.total} />
            <Stat label="排队" value={stats.queued + stats.paused} />
            <Stat label="执行中" value={stats.running} />
            <Stat label="成功" value={stats.succeeded} tone="success" />
            <Stat label="失败" value={stats.failed} tone="danger" />
          </div>

          {batch ? (
            <div className="task-surface">
              <div className="task-toolbar batch-task-toolbar">
                <label>
                  书籍 ID
                  <select value={selectedBookId} onChange={(event) => updateBookFilter(event.target.value)} disabled={batch.status === 'running'}>
                    <option value="all">全部书籍</option>
                    {bookIdOptions.map((bookId) => (
                      <option key={bookId} value={String(bookId)}>
                        {bookId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  任务状态
                  <select value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value as StatusFilter)} disabled={batch.status === 'running'}>
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="selection-summary">
                  <span>命中 {filteredTasks.length}</span>
                  <span>已选 {selectedVisibleTaskIds.length}</span>
                  <span>可生成 {visibleGeneratableTasks.length}</span>
                </div>
                <button
                  className="generate-filter-button"
                  disabled={batch.status === 'running' || isStartingSelected || generateTargetIds.length === 0}
                  onClick={() => void startSelectedTasks()}
                >
                  {isStartingSelected ? <Loader2 className="spin" size={16} /> : <CheckSquare size={16} />}
                  {selectedVisibleTaskIds.length > 0 ? '生成选中' : '生成当前筛选'}
                </button>
              </div>
              <div className="task-table-wrap">
                <table className="task-table">
                  <thead>
                    <tr>
                      <th className="select-column">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          ref={(element) => {
                            if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected;
                          }}
                          disabled={batch.status === 'running' || visibleGeneratableTasks.length === 0}
                          onChange={toggleVisibleSelection}
                          aria-label="选择当前筛选可生成任务"
                        />
                      </th>
                      <th>状态</th>
                      <th>图片</th>
                      <th>来源</th>
                      <th>进度</th>
                      <th>is_valid</th>
                      <th>段落内容</th>
                      <th>结果</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTasks.map((task) => (
                      <tr
                        key={task.id}
                        className={selectedTask?.id === task.id ? 'selected' : ''}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <td className="select-column">
                          <input
                            type="checkbox"
                            checked={selectedTaskIds.has(task.id)}
                            disabled={batch.status === 'running' || !canGenerateTask(task)}
                            onChange={() => toggleTaskSelection(task)}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`选择第 ${task.row_no} 行任务`}
                          />
                        </td>
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
                        <td>
                          <div className="source-cell">
                            <strong>第 {task.row_no} 行</strong>
                            <span>书 {task.input.book_id || '-'} · 章 {task.input.chapter_sort || '-'}</span>
                          </div>
                        </td>
                        <td>
                          <ProgressCell task={task} />
                        </td>
                        <td>
                          <RawValue value={task.is_valid} />
                        </td>
                        <td className="paragraph-column">
                          <div className="paragraph-cell">
                            <p>{truncate(task.input.paragraph_content, 150)}</p>
                            {task.paragraph_description && <small>{truncate(task.paragraph_description, 110)}</small>}
                          </div>
                        </td>
                        <td>
                          <div className="result-cell">
                            <strong>{task.title || '暂无标题'}</strong>
                            <span>{task.elapsed_seconds ? `${task.elapsed_seconds}s` : statusLabel[task.status]}</span>
                          </div>
                        </td>
                        <td>
                          <TaskActions task={task} onAction={(action) => void taskAction(task, action)} />
                        </td>
                      </tr>
                    ))}
                    {filteredTasks.length === 0 && (
                      <tr>
                        <td className="table-empty" colSpan={9}>
                          当前筛选没有匹配任务。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
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
                <div className="result-info">
                  <h2>{selectedTask.title || '暂无标题'}</h2>
                  <div className="result-meta">
                    <span>
                      is_valid：<RawValue value={selectedTask.is_valid} compact />
                    </span>
                    <span>角色：{selectedTask.role?.join('、') || '-'}</span>
                  </div>
                </div>
                {selectedTask.paragraph_description && (
                  <div className="description-output">
                    <strong>生成段落描述</strong>
                    <p>{selectedTask.paragraph_description}</p>
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
              <div className="panel-heading-title">
                <RefreshCw size={18} />
                <span>运行日志</span>
                <small>{batch ? `${batch.events.length} 条` : '0 条'}</small>
              </div>
              <button className="ghost-toggle" onClick={() => setEventLogOpen((current) => !current)}>
                {isEventLogOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                {isEventLogOpen ? '收起' : '展开'}
              </button>
            </div>
            {isEventLogOpen && (
              <div className="event-list">
                {(batch?.events ?? []).slice(0, 5).map((event) => (
                  <div className={`event-item ${event.type}`} key={event.id}>
                    <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                    <span>{event.message}</span>
                  </div>
                ))}
                {!batch && <p className="muted">还没有任务日志。</p>}
              </div>
            )}
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
    </>
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

function formatRawValue(value: unknown) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function RawValue({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const text = formatRawValue(value);
  return <span className={`raw-value ${text === '-' ? 'empty' : ''} ${compact ? 'compact' : ''}`}>{text}</span>;
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

function QualityPromptPage() {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [paragraphColumn, setParagraphColumn] = useState('');
  const [rowLimit, setRowLimit] = useState('');
  const [qualityState, setQualityState] = useState<QualityState | null>(null);
  const [experiment, setExperiment] = useState<QualityExperiment | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedPromptVersionIds, setSelectedPromptVersionIds] = useState<Set<string>>(() => new Set());
  const [isUploading, setUploading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [isRunning, setRunning] = useState(false);
  const [isCalibrating, setCalibrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptPopover, setPromptPopover] = useState<PromptPopoverState | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hidePromptPopoverTimer = useRef<number | null>(null);

  const selectedSheet = useMemo(
    () => workbook?.sheets.find((sheet) => sheet.name === selectedSheetName) ?? null,
    [selectedSheetName, workbook]
  );

  const promptVersions = qualityState?.promptVersions ?? [];
  const activePromptVersion = promptVersions.find((version) => version.id === qualityState?.activePromptVersionId) ?? promptVersions[0];
  const selectedRecord = useMemo(
    () => experiment?.records.find((record) => record.id === selectedRecordId) ?? experiment?.records[0],
    [experiment, selectedRecordId]
  );

  const qualityStats = useMemo(() => {
    const records = experiment?.records ?? [];
    const activeVersionId = qualityState?.activePromptVersionId;
    const judged = records.filter((record) => activeVersionId && record.judgments[activeVersionId]?.status === 'completed').length;
    const mismatches = records.filter((record) => {
      if (!activeVersionId || !record.annotation) return false;
      const judgment = record.judgments[activeVersionId];
      return judgment?.image_value && judgment.image_value !== record.annotation.expectedImageValue;
    }).length;
    return {
      total: records.length,
      judged,
      annotated: records.filter((record) => record.annotation).length,
      mismatches
    };
  }, [experiment, qualityState?.activePromptVersionId]);

  const selectedVersionIds = useMemo(() => {
    if (selectedPromptVersionIds.size > 0) return Array.from(selectedPromptVersionIds);
    return activePromptVersion ? [activePromptVersion.id] : [];
  }, [activePromptVersion, selectedPromptVersionIds]);

  useEffect(() => {
    fetch('/api/quality/state')
      .then((response) => readJson<QualityState>(response))
      .then((state) => {
        setQualityState(state);
        setSelectedPromptVersionIds(new Set([state.activePromptVersionId]));
      })
      .catch((stateError) => setError(stateError instanceof Error ? stateError.message : '读取质量判断状态失败'));
  }, []);

  useEffect(() => {
    const lastExperimentId = localStorage.getItem('dify-quality:lastExperimentId');
    if (!lastExperimentId) return;
    fetch(`/api/quality/experiments/${lastExperimentId}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload) => {
        if (payload) {
          setExperiment(payload);
          setSelectedRecordId(payload.records?.[0]?.id ?? null);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!experiment?.id) return;
    localStorage.setItem('dify-quality:lastExperimentId', experiment.id);
    const source = new EventSource(`/api/quality/experiments/${experiment.id}/events`);
    source.onmessage = (event) => {
      const nextExperiment = JSON.parse(event.data) as QualityExperiment;
      setExperiment(nextExperiment);
      setRunning(nextExperiment.status === 'running');
      setSelectedRecordId((current) => current ?? nextExperiment.records[0]?.id ?? null);
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [experiment?.id]);

  useEffect(() => {
    return () => {
      if (hidePromptPopoverTimer.current !== null) {
        window.clearTimeout(hidePromptPopoverTimer.current);
      }
    };
  }, []);

  async function refreshQualityState() {
    const state = await fetch('/api/quality/state').then((response) => readJson<QualityState>(response));
    setQualityState(state);
    return state;
  }

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
      const firstSheet = nextWorkbook.sheets[0];
      setWorkbook(nextWorkbook);
      setSelectedSheetName(firstSheet?.name ?? '');
      setParagraphColumn(firstSheet?.autoMapping.paragraph_content ?? firstSheet?.headers[0] ?? '');
      setRowLimit('');
      setExperiment(null);
      setSelectedRecordId(null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function createExperiment() {
    if (!workbook || !selectedSheet || !paragraphColumn) return;
    setError(null);
    setCreating(true);
    try {
      let parsedRowLimit: number | undefined;
      if (rowLimit.trim()) {
        parsedRowLimit = Number(rowLimit.trim());
        if (!Number.isInteger(parsedRowLimit) || parsedRowLimit < 1) {
          throw new Error('测试行数必须是大于 0 的整数');
        }
      }
      const nextExperiment = await fetch('/api/quality/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workbookId: workbook.id,
          sheetName: selectedSheet.name,
          paragraphColumn,
          rowLimit: parsedRowLimit,
          promptVersionIds: selectedVersionIds
        })
      }).then((response) => readJson<QualityExperiment>(response));
      setExperiment(nextExperiment);
      setSelectedRecordId(nextExperiment.records[0]?.id ?? null);
      await refreshQualityState();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建测试记录失败');
    } finally {
      setCreating(false);
    }
  }

  async function runQualityJudgment() {
    if (!experiment || selectedVersionIds.length === 0) return;
    setError(null);
    setRunning(true);
    try {
      const nextExperiment = await fetch(`/api/quality/experiments/${experiment.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptVersionIds: selectedVersionIds })
      }).then((response) => readJson<QualityExperiment>(response));
      setExperiment(nextExperiment);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '质量判断启动失败');
      setRunning(false);
    }
  }

  async function annotateRecord(record: QualityRecord, expectedImageValue: ImageValue) {
    if (!experiment) return;
    setError(null);
    try {
      const nextExperiment = await fetch(`/api/quality/experiments/${experiment.id}/records/${record.id}/annotation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedImageValue })
      }).then((response) => readJson<QualityExperiment>(response));
      setExperiment(nextExperiment);
    } catch (annotationError) {
      setError(annotationError instanceof Error ? annotationError.message : '标注失败');
    }
  }

  async function calibratePrompt() {
    if (!experiment || !qualityState?.activePromptVersionId) return;
    setError(null);
    setCalibrating(true);
    try {
      const result = await fetch(`/api/quality/experiments/${experiment.id}/calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptVersionId: qualityState.activePromptVersionId })
      }).then((response) =>
        readJson<{ promptVersion: QualityPromptVersion; state: QualityState; experiment: QualityExperiment }>(response)
      );
      setQualityState(result.state);
      setExperiment(result.experiment);
      setSelectedPromptVersionIds(new Set([result.promptVersion.id]));
    } catch (calibrationError) {
      setError(calibrationError instanceof Error ? calibrationError.message : '校准 Prompt 失败');
    } finally {
      setCalibrating(false);
    }
  }

  function togglePromptVersion(versionId: string) {
    setSelectedPromptVersionIds((current) => {
      const next = new Set(current);
      if (next.has(versionId)) {
        next.delete(versionId);
      } else {
        next.add(versionId);
      }
      return next;
    });
  }

  function clearPromptPopoverTimer() {
    if (hidePromptPopoverTimer.current !== null) {
      window.clearTimeout(hidePromptPopoverTimer.current);
      hidePromptPopoverTimer.current = null;
    }
  }

  function hidePromptPopoverSoon() {
    clearPromptPopoverTimer();
    hidePromptPopoverTimer.current = window.setTimeout(() => {
      setPromptPopover(null);
      hidePromptPopoverTimer.current = null;
    }, 140);
  }

  function showPromptPopover(version: QualityPromptVersion, element: HTMLElement) {
    clearPromptPopoverTimer();
    const rect = element.getBoundingClientRect();
    const viewportPadding = 16;
    const width = Math.min(640, Math.max(360, window.innerWidth - 32));
    const maxHeight = Math.min(560, window.innerHeight - viewportPadding * 2);
    const maxTop = Math.max(viewportPadding, window.innerHeight - maxHeight - viewportPadding);
    const canShowRight = rect.right + 14 + width <= window.innerWidth - viewportPadding;
    const rawLeft = canShowRight ? rect.right + 14 : rect.left - width - 14;
    const left = Math.max(viewportPadding, Math.min(rawLeft, window.innerWidth - width - viewportPadding));
    const top = Math.max(viewportPadding, Math.min(rect.top - 2, maxTop));
    setPromptPopover({
      version,
      top,
      left,
      placement: canShowRight ? 'right' : 'left'
    });
  }

  async function copyPrompt(version: QualityPromptVersion) {
    setError(null);
    try {
      await navigator.clipboard.writeText(version.prompt);
    } catch {
      setError('复制失败：浏览器未允许访问剪贴板');
    }
  }

  return (
    <>
      <section className="topbar quality-topbar">
        <div>
          <h1>质量判断 Prompt 优化</h1>
          <p>上传段落 Excel，调用质量判断工作流，人工校准结果，并保留不同 Prompt 版本的对比记录。</p>
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

      <section className="quality-layout">
        <aside className="left-panel quality-left">
          <div className="panel-section">
            <div className="panel-heading">
              <FileSpreadsheet size={18} />
              <span>测试集</span>
            </div>
            {workbook ? (
              <>
                <div className="file-name">{normalizeDisplayFileName(workbook.fileName)}</div>
                <label className="field-label">
                  工作表
                  <select
                    value={selectedSheetName}
                    onChange={(event) => {
                      const sheet = workbook.sheets.find((item) => item.name === event.target.value);
                      setSelectedSheetName(event.target.value);
                      setParagraphColumn(sheet?.autoMapping.paragraph_content ?? sheet?.headers[0] ?? '');
                    }}
                  >
                    {workbook.sheets.map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} · {sheet.rowCount} 行
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  段落内容
                  <select value={paragraphColumn} onChange={(event) => setParagraphColumn(event.target.value)}>
                    <option value="">选择列</option>
                    {selectedSheet?.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  <span>
                    测试行数
                    <small>默认全部</small>
                  </span>
                  <input
                    min="1"
                    max={selectedSheet?.rowCount}
                    type="number"
                    inputMode="numeric"
                    placeholder={selectedSheet ? `全部 ${selectedSheet.rowCount} 行` : '全部'}
                    value={rowLimit}
                    onChange={(event) => setRowLimit(event.target.value)}
                  />
                </label>
                <button className="wide-button" onClick={() => void createExperiment()} disabled={isCreating || !paragraphColumn}>
                  {isCreating ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  创建测试记录
                </button>
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
              <Sparkles size={18} />
              <span>Prompt 版本</span>
            </div>
            <div className="prompt-version-list">
              {promptVersions.map((version) => (
                <div className="prompt-version-wrap" key={version.id}>
                  <label
                    className="prompt-version-item"
                    onMouseEnter={(event) => showPromptPopover(version, event.currentTarget)}
                    onFocus={(event) => showPromptPopover(version, event.currentTarget)}
                    onMouseLeave={hidePromptPopoverSoon}
                    onBlur={hidePromptPopoverSoon}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPromptVersionIds.has(version.id)}
                      onChange={() => togglePromptVersion(version.id)}
                      disabled={experiment?.status === 'running'}
                    />
                    <span>
                      <strong>{version.name}</strong>
                      <small>{version.id === qualityState?.activePromptVersionId ? '当前版本' : version.calibrationSummary || '历史版本'}</small>
                    </span>
                  </label>
                </div>
              ))}
              {promptVersions.length === 0 && <p className="muted">还没有 Prompt 版本。</p>}
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-heading">
              <Play size={18} />
              <span>执行与校准</span>
            </div>
            <div className="control-grid">
              <button disabled={!experiment || isRunning || selectedVersionIds.length === 0} onClick={() => void runQualityJudgment()}>
                {isRunning ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                执行判断
              </button>
              <button disabled={!experiment || isCalibrating || qualityStats.mismatches === 0} onClick={() => void calibratePrompt()}>
                {isCalibrating ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                提交校准
              </button>
            </div>
            {activePromptVersion && (
              <p className="field-hint">
                当前 Prompt：{activePromptVersion.name} · {truncate(activePromptVersion.calibrationSummary || '可直接传入质量判断工作流', 58)}
              </p>
            )}
          </div>
        </aside>

        <section className="quality-main main-panel">
          <div className="stats-row">
            <Stat label="段落" value={qualityStats.total} />
            <Stat label="已判断" value={qualityStats.judged} />
            <Stat label="已标注" value={qualityStats.annotated} tone="success" />
            <Stat label="需校准" value={qualityStats.mismatches} tone="danger" />
          </div>

          {experiment ? (
            <div className="task-surface">
              <div className="task-toolbar quality-toolbar">
                <div className="selection-summary">
                  <span>{normalizeDisplayFileName(experiment.fileName)}</span>
                  <span>{experiment.sheetName}</span>
                  <span>{experiment.status === 'running' ? '执行中' : '可编辑标注'}</span>
                </div>
              </div>
              <div className="quality-table-wrap">
                <table className="task-table quality-table">
                  <thead>
                    <tr>
                      <th>行号</th>
                      <th>段落内容</th>
                      {experiment.promptVersionIds.map((versionId) => (
                        <th key={versionId}>{promptVersions.find((version) => version.id === versionId)?.name ?? versionId}</th>
                      ))}
                      <th>人工标注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {experiment.records.map((record) => (
                      <tr
                        key={record.id}
                        className={selectedRecord?.id === record.id ? 'selected' : ''}
                        onClick={() => setSelectedRecordId(record.id)}
                      >
                        <td>{record.row_no}</td>
                        <td>{truncate(record.paragraph_content, 110)}</td>
                        {experiment.promptVersionIds.map((versionId) => (
                          <td key={versionId}>
                            <QualityJudgmentCell judgment={record.judgments[versionId]} />
                          </td>
                        ))}
                        <td>
                          <div className="annotation-buttons" onClick={(event) => event.stopPropagation()}>
                            <button
                              className={record.annotation?.expectedImageValue === '有价值' ? 'active yes' : ''}
                              onClick={() => void annotateRecord(record, '有价值')}
                            >
                              有价值
                            </button>
                            <button
                              className={record.annotation?.expectedImageValue === '无价值' ? 'active no' : ''}
                              onClick={() => void annotateRecord(record, '无价值')}
                            >
                              无价值
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
              <SlidersHorizontal size={40} />
              <h2>从段落测试集开始</h2>
              <p>上传 Excel 后，只需映射“段落内容”列，就能执行质量判断与 Prompt 校准。</p>
            </div>
          )}
        </section>

        <aside className="right-panel quality-right">
          <div className="panel-section result-panel">
            <div className="panel-heading">
              <CheckSquare size={18} />
              <span>样本详情</span>
            </div>
            {selectedRecord ? (
              <div className="quality-detail">
                <div className="status-pill queued">第 {selectedRecord.row_no} 行</div>
                <p>{selectedRecord.paragraph_content}</p>
                <div className="annotation-buttons detail-buttons">
                  <button
                    className={selectedRecord.annotation?.expectedImageValue === '有价值' ? 'active yes' : ''}
                    onClick={() => void annotateRecord(selectedRecord, '有价值')}
                  >
                    标注有价值
                  </button>
                  <button
                    className={selectedRecord.annotation?.expectedImageValue === '无价值' ? 'active no' : ''}
                    onClick={() => void annotateRecord(selectedRecord, '无价值')}
                  >
                    标注无价值
                  </button>
                </div>
                <div className="judgment-stack">
                  {experiment?.promptVersionIds.map((versionId) => (
                    <QualityJudgmentCard
                      key={versionId}
                      version={promptVersions.find((version) => version.id === versionId)}
                      judgment={selectedRecord.judgments[versionId]}
                      expected={selectedRecord.annotation?.expectedImageValue}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">选择一条段落查看判断详情。</p>
            )}
          </div>

          <div className="panel-section event-panel">
            <div className="panel-heading">
              <div className="panel-heading-title">
                <RefreshCw size={18} />
                <span>校准日志</span>
                <small>{experiment ? `${experiment.events.length} 条` : '0 条'}</small>
              </div>
            </div>
            <div className="event-list open">
              {(experiment?.events ?? []).slice(0, 8).map((event) => (
                <div className={`event-item ${event.type}`} key={event.id}>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <span>{event.message}</span>
                </div>
              ))}
              {!experiment && <p className="muted">还没有质量判断日志。</p>}
            </div>
          </div>
        </aside>
      </section>
      {promptPopover &&
        createPortal(
          <div
            className={`prompt-popover fixed ${promptPopover.placement}`}
            role="tooltip"
            style={{ top: promptPopover.top, left: promptPopover.left }}
            onMouseEnter={clearPromptPopoverTimer}
            onMouseLeave={hidePromptPopoverSoon}
            onFocus={clearPromptPopoverTimer}
            onBlur={hidePromptPopoverSoon}
          >
            <div className="prompt-popover-head">
              <strong>{promptPopover.version.name}</strong>
              <button type="button" onClick={() => void copyPrompt(promptPopover.version)}>
                复制 Prompt
              </button>
            </div>
            <pre>{promptPopover.version.prompt}</pre>
          </div>,
          document.body
        )}
    </>
  );
}

function QualityJudgmentCell({ judgment }: { judgment?: QualityJudgment }) {
  if (!judgment) return <span className="raw-value empty">未执行</span>;
  if (judgment.status === 'running') {
    return (
      <span className="status-pill running">
        <Loader2 className="spin" size={14} />
        执行中
      </span>
    );
  }
  if (judgment.status === 'failed') {
    return (
      <span className="status-pill failed">
        <XCircle size={14} />
        失败
      </span>
    );
  }
  return (
    <div className="quality-cell">
      <span className={`value-pill ${judgment.image_value === '有价值' ? 'yes' : 'no'}`}>{judgment.image_value ?? '-'}</span>
      <small>{judgment.score ? `${judgment.score} 分` : judgment.recommendation ?? '-'}</small>
    </div>
  );
}

function QualityJudgmentCard({
  version,
  judgment,
  expected
}: {
  version?: QualityPromptVersion;
  judgment?: QualityJudgment;
  expected?: ImageValue;
}) {
  const mismatch = Boolean(expected && judgment?.image_value && expected !== judgment.image_value);
  return (
    <div className={`judgment-card ${mismatch ? 'mismatch' : ''}`}>
      <div className="judgment-card-head">
        <strong>{version?.name ?? judgment?.promptVersionId ?? 'Prompt 版本'}</strong>
        {judgment ? <QualityJudgmentCell judgment={judgment} /> : <span className="raw-value empty">未执行</span>}
      </div>
      {judgment?.reason && <p>{judgment.reason}</p>}
      {judgment?.visual_elements.length ? (
        <div className="token-row">
          {judgment.visual_elements.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {mismatch && <div className="task-error">人工标注为 {expected}，该版本需要校准。</div>}
      {judgment?.error && <div className="task-error">{judgment.error}</div>}
    </div>
  );
}
