import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
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
  Pencil,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react';
import { getRunIsValidValue } from './runIsValid';
import { CharacterExtractionPage } from './CharacterExtractionPage';

type RequiredInputKey = 'book_id' | 'paragraph_content' | 'chapter_sort';
type Mapping = Record<RequiredInputKey, string>;
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';
type StatusFilter = TaskStatus | 'all';
type AppPage = 'books' | 'quality' | 'characters';
type ImagePresenceFilter = 'all' | 'yes' | 'no';
type ValueStatusFilter = 'all' | 'valuable' | 'not_valuable' | 'unknown';
type RangeFilterMode = 'chapter' | 'row';
type TaskPageSize = 20 | 50 | 200;
type QualityPageSize = 20 | 50 | 100;
type BookTaskColumnKey = 'status' | 'image' | 'source' | 'is_valid' | 'paragraph' | 'result' | 'actions';
type BookTaskColumnWidths = Record<BookTaskColumnKey, number>;
type ImageValue = '有价值' | '无价值';
type QualityRunStatus = 'idle' | 'running' | 'completed' | 'failed';
type TaskQueryOverrides = Partial<RangeFilterState> & {
  statusFilter?: StatusFilter;
  taskQuery?: string;
  hasImage?: ImagePresenceFilter;
  valueStatus?: ValueStatusFilter;
};

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
  batch_id?: string;
  source_kind?: string;
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

interface BookSummary {
  book_id: number;
  name?: string;
  task_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  paused_count: number;
  unfinished_count: number;
  last_task_at?: string;
  created_at: string;
  updated_at: string;
}

interface BookBatchSummary {
  id: string;
  file_name: string;
  sheet_name: string;
  status: Batch['status'];
  created_at: string;
  updated_at: string;
  task_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  paused_count: number;
  unfinished_count: number;
}

interface TaskRunRecord {
  id: string;
  task_id: string;
  attempt_no: number;
  status: TaskStatus;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds?: number;
  workflow_run_id?: string;
  dify_task_id?: string;
  is_valid?: unknown;
  result_files: ResultFile[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
  created_at: string;
}

interface TaskPagination {
  page: number;
  pageSize: TaskPageSize;
  total: number;
  totalPages: number;
  runnableTotal: number;
}

interface AppHealthConfig {
  config?: {
    difyWorkflowName?: string | null;
  };
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

const IMAGE_FILTER_OPTIONS: Array<{ value: ImagePresenceFilter; label: string }> = [
  { value: 'all', label: '全部图片' },
  { value: 'yes', label: '有图' },
  { value: 'no', label: '无图' }
];

const VALUE_FILTER_OPTIONS: Array<{ value: ValueStatusFilter; label: string }> = [
  { value: 'all', label: '全部价值' },
  { value: 'valuable', label: '有价值' },
  { value: 'not_valuable', label: '无价值' },
  { value: 'unknown', label: '未知' }
];

const TASK_PAGE_SIZE_OPTIONS: TaskPageSize[] = [20, 50, 200];
const QUALITY_PAGE_SIZE_OPTIONS: QualityPageSize[] = [20, 50, 100];
const DEFAULT_RANGE_FILTER_STATE = {
  mode: 'chapter' as RangeFilterMode,
  chapterFrom: '',
  chapterTo: '',
  rowNoFrom: '',
  rowNoTo: ''
};

function taskListPageSize(taskCount?: number): TaskPageSize {
  return taskCount && taskCount <= 200 ? 200 : 50;
}

type RangeFilterState = typeof DEFAULT_RANGE_FILTER_STATE;
type TaskQueryState = RangeFilterState & {
  statusFilter: StatusFilter;
  taskQuery: string;
  hasImage: ImagePresenceFilter;
  valueStatus: ValueStatusFilter;
};

const DEFAULT_TASK_QUERY_STATE: TaskQueryState = {
  ...DEFAULT_RANGE_FILTER_STATE,
  statusFilter: 'all',
  taskQuery: '',
  hasImage: 'all',
  valueStatus: 'all'
};

const qualityStatusLabel: Record<QualityRunStatus, string> = {
  idle: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败'
};

const BOOK_TASK_TABLE_WIDTHS_KEY = 'dify-books:task-table-column-widths';
const BOOK_TASK_COLUMN_CONFIG: Array<{ key: BookTaskColumnKey; label: string; defaultWidth: number; minWidth: number; maxWidth: number }> = [
  { key: 'status', label: '状态', defaultWidth: 116, minWidth: 92, maxWidth: 180 },
  { key: 'image', label: '图片', defaultWidth: 92, minWidth: 70, maxWidth: 150 },
  { key: 'source', label: '来源', defaultWidth: 150, minWidth: 112, maxWidth: 240 },
  { key: 'is_valid', label: 'is_valid', defaultWidth: 96, minWidth: 80, maxWidth: 160 },
  { key: 'paragraph', label: '段落内容', defaultWidth: 300, minWidth: 180, maxWidth: 760 },
  { key: 'result', label: '结果', defaultWidth: 180, minWidth: 128, maxWidth: 360 },
  { key: 'actions', label: '操作', defaultWidth: 126, minWidth: 104, maxWidth: 180 }
];

const DEFAULT_BOOK_TASK_COLUMN_WIDTHS = BOOK_TASK_COLUMN_CONFIG.reduce((widths, column) => {
  widths[column.key] = column.defaultWidth;
  return widths;
}, {} as BookTaskColumnWidths);

async function readJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
  const fallbackText = contentType.includes('application/json') ? '' : await response.text().catch(() => '');
  if (!response.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : fallbackText.trim()
          ? `请求失败：${response.status} ${fallbackText.trim()}`
          : `请求失败：${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function isNetworkFetchError(error: unknown) {
  return error instanceof TypeError && error.message.toLowerCase().includes('fetch');
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

function formatQualityTaskName(fileName: string, duplicateIndex?: number) {
  const displayName = normalizeDisplayFileName(fileName);
  return duplicateIndex ? `${displayName}（${duplicateIndex}）` : displayName;
}

function buildQualityTaskItems(experiments: QualityExperimentSummary[]) {
  const normalizedCounts = experiments.reduce((counts, item) => {
    const name = normalizeDisplayFileName(item.fileName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const ordersByName = new Map<string, number>();
  const duplicateOrder = [...experiments]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    .reduce((orders, item) => {
      const name = normalizeDisplayFileName(item.fileName);
      if ((normalizedCounts.get(name) ?? 0) <= 1) return orders;
      orders.set(item.id, (ordersByName.get(name) ?? 0) + 1);
      ordersByName.set(name, orders.get(item.id) ?? 1);
      return orders;
    }, new Map<string, number>());

  return experiments.map((item) => ({
    ...item,
    taskName: formatQualityTaskName(item.fileName, duplicateOrder.get(item.id))
  }));
}

function formatCompactDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatElapsedFrom(value?: string) {
  if (!value) return '';
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function clampColumnWidth(columnKey: BookTaskColumnKey, width: number) {
  const config = BOOK_TASK_COLUMN_CONFIG.find((column) => column.key === columnKey);
  const minWidth = config?.minWidth ?? 80;
  const maxWidth = config?.maxWidth ?? 760;
  return Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
}

function loadBookTaskColumnWidths(): BookTaskColumnWidths {
  if (typeof window === 'undefined') return { ...DEFAULT_BOOK_TASK_COLUMN_WIDTHS };
  try {
    const raw = window.localStorage.getItem(BOOK_TASK_TABLE_WIDTHS_KEY);
    if (!raw) return { ...DEFAULT_BOOK_TASK_COLUMN_WIDTHS };
    const parsed = JSON.parse(raw) as Partial<Record<BookTaskColumnKey, unknown>>;
    return BOOK_TASK_COLUMN_CONFIG.reduce((widths, column) => {
      const value = parsed[column.key];
      widths[column.key] =
        typeof value === 'number' && Number.isFinite(value)
          ? clampColumnWidth(column.key, value)
          : column.defaultWidth;
      return widths;
    }, {} as BookTaskColumnWidths);
  } catch {
    return { ...DEFAULT_BOOK_TASK_COLUMN_WIDTHS };
  }
}

function saveBookTaskColumnWidths(widths: BookTaskColumnWidths) {
  try {
    window.localStorage?.setItem(BOOK_TASK_TABLE_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Some embedded browser contexts can block localStorage; resizing should still work for the current session.
  }
}

function buildTaskQueryState(
  draft: TaskQueryState,
  overrides: TaskQueryOverrides = {}
): TaskQueryState {
  return {
    mode: overrides.mode ?? draft.mode,
    chapterFrom: overrides.chapterFrom ?? draft.chapterFrom,
    chapterTo: overrides.chapterTo ?? draft.chapterTo,
    rowNoFrom: overrides.rowNoFrom ?? draft.rowNoFrom,
    rowNoTo: overrides.rowNoTo ?? draft.rowNoTo,
    statusFilter: overrides.statusFilter ?? draft.statusFilter,
    taskQuery: overrides.taskQuery ?? draft.taskQuery,
    hasImage: overrides.hasImage ?? draft.hasImage,
    valueStatus: overrides.valueStatus ?? draft.valueStatus
  };
}

function createTaskQueryParams(queryState: TaskQueryState, page: number, pageSize: number, taskListId: string) {
  const params = new URLSearchParams();
  if (queryState.statusFilter !== 'all') params.set('status', queryState.statusFilter);
  if (taskListId !== 'all') params.set('batchId', taskListId);
  if (queryState.taskQuery.trim()) params.set('q', queryState.taskQuery.trim());
  if (queryState.mode === 'chapter') {
    if (queryState.chapterFrom.trim()) params.set('chapterSortFrom', queryState.chapterFrom.trim());
    if (queryState.chapterTo.trim()) params.set('chapterSortTo', queryState.chapterTo.trim());
  } else {
    if (queryState.rowNoFrom.trim()) params.set('rowNoFrom', queryState.rowNoFrom.trim());
    if (queryState.rowNoTo.trim()) params.set('rowNoTo', queryState.rowNoTo.trim());
  }
  if (queryState.hasImage !== 'all') params.set('hasImage', queryState.hasImage);
  if (queryState.valueStatus !== 'all') params.set('valueStatus', queryState.valueStatus);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params;
}

function describeTaskQueryScope(queryState: TaskQueryState) {
  const fragments: string[] = [];
  if (queryState.statusFilter !== 'all') fragments.push(`状态 ${statusLabel[queryState.statusFilter]}`);
  if (queryState.hasImage !== 'all') fragments.push(`图片 ${imageStatusLabel(queryState.hasImage)}`);
  if (queryState.valueStatus !== 'all') fragments.push(`价值 ${valueStatusLabel(queryState.valueStatus)}`);
  if (queryState.mode === 'chapter' && (queryState.chapterFrom.trim() || queryState.chapterTo.trim())) {
    fragments.push(`章节 ${queryState.chapterFrom.trim() || '-'}-${queryState.chapterTo.trim() || '-'}`);
  }
  if (queryState.mode === 'row' && (queryState.rowNoFrom.trim() || queryState.rowNoTo.trim())) {
    fragments.push(`行号 ${queryState.rowNoFrom.trim() || '-'}-${queryState.rowNoTo.trim() || '-'}`);
  }
  if (queryState.taskQuery.trim()) fragments.push(`关键词 ${queryState.taskQuery.trim()}`);
  return fragments.length === 0 ? '当前任务清单全部任务' : fragments.join(' / ');
}

export function App() {
  const initialPageParam = new URLSearchParams(window.location.search).get('page');
  const initialPage: AppPage =
    initialPageParam === 'quality' ? 'quality' : initialPageParam === 'characters' ? 'characters' : 'books';
  const [page, setPage] = useState<AppPage>(initialPage);
  const [difyWorkflowName, setDifyWorkflowName] = useState('LL-段落高光生图-效果测试');

  useEffect(() => {
    fetch('/api/health')
      .then((response) => readJson<AppHealthConfig>(response))
      .then((payload) => {
        if (payload.config?.difyWorkflowName) {
          setDifyWorkflowName(payload.config.difyWorkflowName);
        }
      })
      .catch(() => {
        setDifyWorkflowName('LL-段落高光生图-效果测试');
      });
  }, []);

  function updatePage(nextPage: AppPage) {
    setPage(nextPage);
    const url = new URL(window.location.href);
    if (nextPage === 'quality' || nextPage === 'characters') {
      url.searchParams.set('page', nextPage);
    } else {
      url.searchParams.delete('page');
    }
    window.history.replaceState({}, '', url);
  }

  return (
    <main className="app-shell side-shell">
      {page === 'quality' ? (
        <QualityWorkspace onNavigate={updatePage} difyWorkflowName={difyWorkflowName} />
      ) : page === 'characters' ? (
        <CharacterWorkspace onNavigate={updatePage} difyWorkflowName={difyWorkflowName} />
      ) : (
        <BooksManagementPage page={page} onNavigate={updatePage} difyWorkflowName={difyWorkflowName} />
      )}
    </main>
  );
}

function WorkspaceSidebar({
  page,
  onChange,
  difyWorkflowName,
  bookDirectory,
  children
}: {
  page: AppPage;
  onChange: (page: AppPage) => void;
  difyWorkflowName: string;
  bookDirectory?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <aside className="workspace-sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">D</div>
        <div>
          <strong>Dify 书籍库</strong>
          <span>高光段落生图工作台</span>
        </div>
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-nav-group">
          <button className={page === 'books' ? 'active' : ''} onClick={() => onChange('books')}>
            <BookOpen size={16} />
            书籍库
          </button>
          {bookDirectory}
        </div>
        <button className={page === 'quality' ? 'active' : ''} onClick={() => onChange('quality')}>
          <SlidersHorizontal size={16} />
          质量判断
        </button>
        <button className={page === 'characters' ? 'active' : ''} onClick={() => onChange('characters')}>
          <ImageIcon size={16} />
          角色形象提取
        </button>
      </nav>
      {children}
      <div className="sidebar-workflow-info" aria-label="当前 Dify 工作流">
        <span>Dify 工作流</span>
        <strong title={difyWorkflowName}>{difyWorkflowName}</strong>
      </div>
    </aside>
  );
}

function QualityWorkspace({ onNavigate, difyWorkflowName }: { onNavigate: (page: AppPage) => void; difyWorkflowName: string }) {
  return (
    <div className="workspace-frame">
      <WorkspaceSidebar page="quality" onChange={onNavigate} difyWorkflowName={difyWorkflowName}>
        <div className="sidebar-note">
          <Sparkles size={16} />
          <span>质量判断保留为辅助工具，生图任务仍在书籍库中管理。</span>
        </div>
      </WorkspaceSidebar>
      <section className="workspace-content quality-workspace-content">
        <QualityPromptPage />
      </section>
    </div>
  );
}

function CharacterWorkspace({ onNavigate, difyWorkflowName }: { onNavigate: (page: AppPage) => void; difyWorkflowName: string }) {
  return (
    <div className="workspace-frame">
      <WorkspaceSidebar page="characters" onChange={onNavigate} difyWorkflowName={difyWorkflowName}>
        <div className="sidebar-note">
          <ImageIcon size={16} />
          <span>从段落场景图中提取主要人物，并生成纯白背景人物立绘。</span>
        </div>
      </WorkspaceSidebar>
      <section className="workspace-content quality-workspace-content">
        <CharacterExtractionPage difyWorkflowName={difyWorkflowName} />
      </section>
    </div>
  );
}

export function BatchWorkflowPage() {
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
      setError(createError instanceof Error ? createError.message : '创建任务清单失败');
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
      if (isNetworkFetchError(exportError)) {
        const refreshedBatch = await fetch(`/api/batches/${batch.id}`)
          .then((response) => readJson<Batch>(response))
          .catch(() => undefined);
        if (refreshedBatch?.export) {
          setBatch(refreshedBatch);
          setError(null);
          return;
        }
        setError('导出请求连接中断，请确认本地后端服务正在运行后重试');
        return;
      }
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
                <p className="muted">上传、映射、编译和执行控制集中在这里；创建任务清单后会自动收起。</p>
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
                  <ImagePlaceholder task={selectedTask} />
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
  const elapsed = task.status === 'running' ? formatElapsedFrom(task.started_at) : '';

  return (
    <div className={`progress-cell ${wide ? 'wide' : ''}`}>
      <div className="progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>{elapsed ? `${label} · 已等待 ${elapsed}` : label}</small>
    </div>
  );
}

function ImagePlaceholder({ task }: { task: BatchTask }) {
  if (task.status === 'running') {
    return (
      <div className="image-placeholder running">
        <Loader2 className="spin" size={24} />
        <strong>图片生成中</strong>
        <span>{task.progress_label ?? '等待 Dify 返回最终图片'}{task.started_at ? ` · 已等待 ${formatElapsedFrom(task.started_at)}` : ''}</span>
        {task.paragraph_description && <small>已生成段落描述，正在等待图片节点完成。</small>}
      </div>
    );
  }

  return (
    <div className="image-placeholder">
      <ImageIcon size={24} />
      暂无图片
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function runOutputField(run: TaskRunRecord, key: string) {
  return asObject(run.raw_outputs)?.[key];
}

function runOutputString(run: TaskRunRecord, key: string) {
  const value = runOutputField(run, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function runTitle(run: TaskRunRecord) {
  const title = runOutputString(run, 'title');
  if (title) return title;
  if (!run.result_text) return '暂无标题';
  return truncate(run.result_text.replace(/\s+/g, ' '), 40);
}

function runDescription(run: TaskRunRecord) {
  const paragraphDescription = runOutputString(run, 'paragraph_description');
  if (paragraphDescription) return paragraphDescription;
  const description = runOutputString(run, 'description');
  if (description) return description;
  if (!run.result_text) return undefined;
  return truncate(run.result_text.replace(/\s+/g, ' '), 80);
}

function runIsValid(run: TaskRunRecord) {
  const value = getRunIsValidValue(run);
  return value === undefined ? '-' : formatRawValue(value);
}

function imageStatusLabel(value: ImagePresenceFilter) {
  return value === 'yes' ? '有图' : value === 'no' ? '无图' : '全部图片';
}

function valueStatusLabel(value: ValueStatusFilter) {
  return value === 'valuable' ? '有价值' : value === 'not_valuable' ? '无价值' : value === 'unknown' ? '未知' : '全部价值';
}

function TaskActions({ task, onAction }: { task: BatchTask; onAction: (action: 'pause' | 'retry' | 'delete') => void }) {
  const validationFailed = task.error?.startsWith('字段校验失败') ?? false;
  const canPause = task.status === 'queued' || task.status === 'running';
  const canRetry = ['failed', 'paused', 'succeeded'].includes(task.status) && !validationFailed && Boolean(task.batch_id);
  const deletingLabel = task.status === 'running' ? '停止并删除' : '删除';

  return (
    <div className="task-actions" onClick={(event) => event.stopPropagation()}>
      <button aria-label={`暂停第 ${task.row_no} 行任务`} title="暂停任务" disabled={!canPause} onClick={() => onAction('pause')}>
        <Pause size={14} />
      </button>
      <button
        aria-label={`重试第 ${task.row_no} 行任务`}
        title={task.batch_id ? '重试任务' : '没有来源文档任务清单，不能重新生图'}
        disabled={!canRetry}
        onClick={() => onAction('retry')}
      >
        <RefreshCw size={14} />
      </button>
      <button aria-label={`${deletingLabel}第 ${task.row_no} 行任务`} title={deletingLabel} onClick={() => onAction('delete')}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function ResizableTableHeader({
  column,
  onResizeStart
}: {
  column: (typeof BOOK_TASK_COLUMN_CONFIG)[number];
  onResizeStart: (columnKey: BookTaskColumnKey, clientX: number, target: HTMLButtonElement, pointerId?: number) => void;
}) {
  return (
    <th className="resizable-th" scope="col">
      <span>{column.label}</span>
      <button
        aria-label={`调整${column.label}列宽`}
        className="column-resizer"
        title="拖动调整列宽"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart(column.key, event.clientX, event.currentTarget, event.pointerId);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart(column.key, event.clientX, event.currentTarget);
        }}
      />
    </th>
  );
}

function BooksManagementPage({
  page,
  onNavigate,
  difyWorkflowName
}: {
  page: AppPage;
  onNavigate: (page: AppPage) => void;
  difyWorkflowName: string;
}) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<number | null>(null);
  const [batches, setBatches] = useState<BookBatchSummary[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('all');
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRunRecord[]>([]);
  const [compareRunIds, setCompareRunIds] = useState<string[]>([]);
  const [taskQuery, setTaskQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [chapterFrom, setChapterFrom] = useState('');
  const [chapterTo, setChapterTo] = useState('');
  const [hasImage, setHasImage] = useState<ImagePresenceFilter>('all');
  const [valueStatus, setValueStatus] = useState<ValueStatusFilter>('all');
  const [rangeFilterMode, setRangeFilterMode] = useState<RangeFilterMode>('chapter');
  const [isRangeFilterOpen, setRangeFilterOpen] = useState(false);
  const [rowNoFrom, setRowNoFrom] = useState('');
  const [rowNoTo, setRowNoTo] = useState('');
  const [appliedTaskQueryState, setAppliedTaskQueryState] = useState<TaskQueryState>(DEFAULT_TASK_QUERY_STATE);
  const [taskPage, setTaskPage] = useState(1);
  const [taskPageSize, setTaskPageSize] = useState<TaskPageSize>(50);
  const [taskPagination, setTaskPagination] = useState<TaskPagination>({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    runnableTotal: 0
  });
  const [isLoadingTasks, setLoadingTasks] = useState(false);
  const [isContinuing, setContinuing] = useState(false);
  const [isRunLogOpen, setRunLogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxFile, setLightboxFile] = useState<ResultFile | null>(null);
  const [isUploading, setUploading] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [editingBatchName, setEditingBatchName] = useState('');
  const [savingBatchNameId, setSavingBatchNameId] = useState<string | null>(null);
  const [recentImportedBookIds, setRecentImportedBookIds] = useState<number[]>([]);
  const [taskColumnWidths, setTaskColumnWidths] = useState<BookTaskColumnWidths>(() => loadBookTaskColumnWidths());
  const taskColumnWidthsRef = useRef(taskColumnWidths);
  const activeColumnResizeRef = useRef<BookTaskColumnKey | null>(null);
  const batchUploadInputRef = useRef<HTMLInputElement | null>(null);
  const rangeFilterRef = useRef<HTMLDivElement | null>(null);
  const appliedTaskQueryStateByScopeRef = useRef<Record<string, TaskQueryState>>({});

  const selectedBook = useMemo(() => books.find((book) => book.book_id === selectedBookId) ?? books[0], [books, selectedBookId]);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks.find((task) => task.result_files.length > 0) ?? tasks[0],
    [selectedTaskId, tasks]
  );
  const compareRuns = useMemo(
    () => compareRunIds.map((runId) => runs.find((run) => run.id === runId)).filter((run): run is TaskRunRecord => Boolean(run)),
    [compareRunIds, runs]
  );
  const selectedBatch = useMemo(() => batches.find((batch) => batch.id === selectedBatchId), [batches, selectedBatchId]);
  const isAllTaskListView = selectedBatchId === 'all';
  const runningTask = useMemo(() => tasks.find((task) => task.status === 'running'), [tasks]);
  const selectedBatchIsRunning = selectedBatch?.status === 'running' || Boolean(runningTask);
  const rangeFilterSummary = useMemo(() => {
    if (rangeFilterMode === 'chapter') {
      if (!chapterFrom.trim() && !chapterTo.trim()) return '按章节';
      return `章节 ${chapterFrom.trim() || '-'}-${chapterTo.trim() || '-'}`;
    }
    if (!rowNoFrom.trim() && !rowNoTo.trim()) return '按行数';
    return `行 ${rowNoFrom.trim() || '-'}-${rowNoTo.trim() || '-'}`;
  }, [chapterFrom, chapterTo, rangeFilterMode, rowNoFrom, rowNoTo]);
  const continueScopeText = useMemo(() => describeTaskQueryScope(appliedTaskQueryState), [appliedTaskQueryState]);
  const taskTableMinWidth = useMemo(
    () => BOOK_TASK_COLUMN_CONFIG.reduce((total, column) => total + taskColumnWidths[column.key], 0),
    [taskColumnWidths]
  );

  useEffect(() => {
    taskColumnWidthsRef.current = taskColumnWidths;
  }, [taskColumnWidths]);

  useEffect(() => {
    if (!isRangeFilterOpen) return;

    function closeRangeFilterOnOutsideClick(event: Event) {
      const target = event.target;
      if (!(target instanceof Node) || rangeFilterRef.current?.contains(target)) return;
      setRangeFilterOpen(false);
    }

    document.addEventListener('pointerdown', closeRangeFilterOnOutsideClick);
    document.addEventListener('mousedown', closeRangeFilterOnOutsideClick);
    document.addEventListener('click', closeRangeFilterOnOutsideClick);
    return () => {
      document.removeEventListener('pointerdown', closeRangeFilterOnOutsideClick);
      document.removeEventListener('mousedown', closeRangeFilterOnOutsideClick);
      document.removeEventListener('click', closeRangeFilterOnOutsideClick);
    };
  }, [isRangeFilterOpen]);

  function rangeFilterScopeKey(bookId = selectedBook?.book_id, taskListId = selectedBatchId) {
    return `${bookId ?? 'none'}:${taskListId}`;
  }

  function taskQueryStateForScope(bookId = selectedBook?.book_id, taskListId = selectedBatchId): TaskQueryState {
    return appliedTaskQueryStateByScopeRef.current[rangeFilterScopeKey(bookId, taskListId)] ?? DEFAULT_TASK_QUERY_STATE;
  }

  function currentRangeFilterState(): RangeFilterState {
    return {
      mode: rangeFilterMode,
      chapterFrom,
      chapterTo,
      rowNoFrom,
      rowNoTo
    };
  }

  function currentTaskQueryState(): TaskQueryState {
    return {
      ...currentRangeFilterState(),
      statusFilter,
      taskQuery,
      hasImage,
      valueStatus
    };
  }

  function applyRangeFilterState(state: RangeFilterState = DEFAULT_RANGE_FILTER_STATE) {
    setRangeFilterMode(state.mode);
    setChapterFrom(state.chapterFrom);
    setChapterTo(state.chapterTo);
    setRowNoFrom(state.rowNoFrom);
    setRowNoTo(state.rowNoTo);
  }

  function applyTaskQueryState(state: TaskQueryState) {
    setStatusFilter(state.statusFilter);
    setTaskQuery(state.taskQuery);
    setHasImage(state.hasImage);
    setValueStatus(state.valueStatus);
    applyRangeFilterState(state);
  }

  function switchTaskScope(nextBookId = selectedBook?.book_id, nextTaskListId = selectedBatchId) {
    appliedTaskQueryStateByScopeRef.current[rangeFilterScopeKey()] = appliedTaskQueryState;
    const nextQueryState = taskQueryStateForScope(nextBookId, nextTaskListId);
    applyTaskQueryState(nextQueryState);
    setAppliedTaskQueryState(nextQueryState);
    setRangeFilterOpen(false);
    return nextQueryState;
  }

  function pageSizeForScope(taskListId = selectedBatchId, book = selectedBook) {
    if (taskListId === 'all') return taskListPageSize(book?.task_count);
    return taskListPageSize(batches.find((batch) => batch.id === taskListId)?.task_count);
  }

  async function loadBooks(preferredBookId?: number) {
    setError(null);
    try {
      const payload = await fetch('/api/books').then((response) => readJson<{ books: BookSummary[] }>(response));
      setBooks(payload.books);
      setSelectedBookId((current) => preferredBookId ?? (current && payload.books.some((book) => book.book_id === current) ? current : payload.books[0]?.book_id ?? null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载书籍失败');
    }
  }

  async function loadBookBatches(bookId = selectedBook?.book_id, preferredTaskListId?: string) {
    if (!bookId) {
      setBatches([]);
      return;
    }
    const payload = await fetch(`/api/books/${bookId}/batches`).then((response) => readJson<{ batches: BookBatchSummary[] }>(response));
    setBatches(payload.batches);
    setSelectedBatchId((current) => {
      if (preferredTaskListId && payload.batches.some((batch) => batch.id === preferredTaskListId)) return preferredTaskListId;
      return current === 'all' || payload.batches.some((batch) => batch.id === current) ? current : 'all';
    });
  }

  async function loadBookTasks(
    bookId = selectedBook?.book_id,
    page = taskPage,
    taskListId = selectedBatchId,
    overrides: TaskQueryOverrides = {},
    pageSize = taskPageSize,
    baseQueryState = taskQueryStateForScope(bookId, taskListId)
  ) {
    if (!bookId) {
      setTasks([]);
      setTaskPagination({ page: 1, pageSize, total: 0, totalPages: 1, runnableTotal: 0 });
      return;
    }
    setLoadingTasks(true);
    setError(null);
    try {
      const nextQueryState = buildTaskQueryState(baseQueryState, overrides);
      const params = createTaskQueryParams(nextQueryState, page, pageSize, taskListId);
      const payload = await fetch(`/api/books/${bookId}/tasks?${params.toString()}`).then((response) =>
        readJson<{ tasks: BatchTask[]; pagination: TaskPagination }>(response)
      );
      setTasks(payload.tasks);
      setTaskPagination(payload.pagination);
      appliedTaskQueryStateByScopeRef.current[rangeFilterScopeKey(bookId, taskListId)] = nextQueryState;
      setAppliedTaskQueryState(nextQueryState);
      if (payload.pagination.page !== taskPage) {
        setTaskPage(payload.pagination.page);
      }
      setSelectedTaskId((current) => (current && payload.tasks.some((task) => task.id === current) ? current : payload.tasks[0]?.id ?? null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载任务失败');
    } finally {
      setLoadingTasks(false);
    }
  }

  async function loadRuns(taskId = selectedTask?.id) {
    if (!taskId) {
      setRuns([]);
      setCompareRunIds([]);
      return;
    }
    try {
      const payload = await fetch(`/api/tasks/${taskId}/runs`).then((response) => readJson<{ runs: TaskRunRecord[] }>(response));
      setRuns(payload.runs);
      setCompareRunIds((current) => current.filter((runId) => payload.runs.some((run) => run.id === runId)));
    } catch {
      setRuns([]);
      setCompareRunIds([]);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBooks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const bookId = selectedBook?.book_id;
    if (!bookId) return;
    const timer = window.setTimeout(() => {
      void loadBookBatches(bookId);
      void loadBookTasks(bookId);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBook?.book_id, selectedBatchId, taskPage, taskPageSize]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRuns(selectedTask?.id);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id]);

  useEffect(() => {
    if (selectedBatchId === 'all') return undefined;
    const source = new EventSource(`/api/batches/${selectedBatchId}/events`);
    source.onmessage = (event) => {
      const nextBatch = JSON.parse(event.data) as Batch;
      if (!selectedBook?.book_id) return;
      setBatches((current) =>
        current.map((batch) =>
          batch.id === nextBatch.id
            ? {
                ...batch,
                status: nextBatch.status,
                updated_at: nextBatch.updatedAt,
                task_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id).length,
                queued_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id && task.status === 'queued').length,
                running_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id && task.status === 'running').length,
                succeeded_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id && task.status === 'succeeded').length,
                failed_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id && task.status === 'failed').length,
                paused_count: nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id && task.status === 'paused').length,
                unfinished_count: nextBatch.tasks.filter(
                  (task) => task.input.book_id === selectedBook.book_id && ['queued', 'running', 'failed', 'paused'].includes(task.status)
                ).length
              }
            : batch
        )
      );
      setTasks((current) => {
        const updates = new Map(nextBatch.tasks.filter((task) => task.input.book_id === selectedBook.book_id).map((task) => [task.id, task]));
        return current.map((task) => updates.get(task.id) ?? task);
      });
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [selectedBatchId, selectedBook?.book_id]);

  useEffect(() => {
    if (!selectedBook?.book_id || selectedBatchId === 'all' || !selectedBatchIsRunning) return undefined;
    const timer = window.setInterval(() => {
      void loadBookBatches(selectedBook.book_id);
      void loadBookTasks(selectedBook.book_id, taskPage, selectedBatchId);
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBook?.book_id, selectedBatchId, selectedBatchIsRunning, taskPage]);

  async function searchTasks() {
    setTaskPage(1);
    await loadBookTasks(selectedBook?.book_id, 1, selectedBatchId, {}, taskPageSize, currentTaskQueryState());
  }

  async function applyRangeFilterSearch() {
    const nextQueryState = buildTaskQueryState(appliedTaskQueryState, currentRangeFilterState());
    applyTaskQueryState(nextQueryState);
    setRangeFilterOpen(false);
    setTaskPage(1);
    await loadBookTasks(selectedBook?.book_id, 1, selectedBatchId, {}, taskPageSize, nextQueryState);
  }

  async function clearRangeFilterSearch() {
    const nextQueryState = buildTaskQueryState(currentTaskQueryState(), DEFAULT_RANGE_FILTER_STATE);
    applyTaskQueryState(nextQueryState);
    setRangeFilterOpen(false);
    setTaskPage(1);
    await loadBookTasks(selectedBook?.book_id, 1, selectedBatchId, DEFAULT_RANGE_FILTER_STATE, taskPageSize, nextQueryState);
  }

  function toggleRunCompare(runId: string) {
    setCompareRunIds((current) => {
      if (current.includes(runId)) {
        return current.filter((id) => id !== runId);
      }
      return [...current, runId].slice(-2);
    });
  }

  async function showRunningTasks() {
    if (!selectedBook || selectedBatchId === 'all') return;
    const nextQueryState = {
      ...DEFAULT_TASK_QUERY_STATE,
      statusFilter: 'running' as StatusFilter
    };
    applyTaskQueryState(nextQueryState);
    setTaskPage(1);
    await loadBookTasks(selectedBook.book_id, 1, selectedBatchId, {
      ...DEFAULT_RANGE_FILTER_STATE,
      statusFilter: 'running',
      taskQuery: '',
      hasImage: 'all',
      valueStatus: 'all'
    }, taskPageSize, nextQueryState);
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
      if (!firstSheet) {
        throw new Error('未读取到可用工作表');
      }
      const mapping = firstSheet.autoMapping;
      const missing = REQUIRED_FIELDS.filter((field) => !mapping[field.key]);
      if (missing.length > 0) {
        throw new Error(`自动识别字段失败：缺少 ${missing.map((item) => item.label).join('、')}，请检查 Excel 表头`);
      }
      const nextBatch = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbookId: nextWorkbook.id, sheetName: firstSheet.name, mapping })
      }).then((response) => readJson<Batch>(response));
      const bookIds = Array.from(new Set(nextBatch.tasks.map((task) => task.input.book_id).filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
      const nextPageSize = taskListPageSize(nextBatch.tasks.filter((task) => task.input.book_id === bookIds[0]).length);
      setRecentImportedBookIds(bookIds);
      const nextQueryState = switchTaskScope(bookIds[0], nextBatch.id);
      setSelectedBatchId(nextBatch.id);
      setTaskPageSize(nextPageSize);
      await loadBooks(bookIds[0]);
      await loadBookBatches(bookIds[0], nextBatch.id);
      await loadBookTasks(bookIds[0], 1, nextBatch.id, {}, nextPageSize, nextQueryState);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传并编译失败');
    } finally {
      setUploading(false);
    }
  }

  async function continueTasks() {
    if (!selectedBook) return;
    if (selectedBatchId === 'all') {
      setError('请先选择一个上传文档任务清单后再执行生图');
      return;
    }
    if (!selectedBatch) {
      setError('当前任务清单不存在，请刷新后重试');
      return;
    }
    if (selectedBatchIsRunning) {
      setError(runningTask ? `当前任务清单正在执行中：第 ${runningTask.row_no} 行（${runningTask.progress_label ?? '执行中'}）` : '当前任务清单正在执行中');
      return;
    }
    setContinuing(true);
    setError(null);
    try {
      const params = createTaskQueryParams(appliedTaskQueryState, 1, taskPageSize, selectedBatchId);
      params.delete('page');
      params.delete('pageSize');
      const query = params.toString();
      const batch = await fetch(`/api/books/${selectedBook.book_id}/continue${query ? `?${query}` : ''}`, { method: 'POST' }).then((response) => readJson<Batch>(response));
      const nextPageSize = taskListPageSize(batch.tasks.filter((task) => task.input.book_id === selectedBook.book_id).length);
      const nextQueryState = taskQueryStateForScope(selectedBook.book_id, batch.id);
      setSelectedBatchId(batch.id);
      setTaskPageSize(nextPageSize);
      setTaskPage(1);
      await loadBooks(selectedBook.book_id);
      await loadBookBatches(selectedBook.book_id, batch.id);
      await loadBookTasks(selectedBook.book_id, 1, batch.id, {}, nextPageSize, nextQueryState);
    } catch (continueError) {
      setError(continueError instanceof Error ? continueError.message : '继续执行失败');
    } finally {
      setContinuing(false);
    }
  }

  async function storedTaskAction(task: BatchTask, action: 'pause' | 'retry' | 'delete') {
    setError(null);
    try {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const suffix = action === 'delete' ? '' : `/${action}`;
      const result = await fetch(`/api/tasks/${task.id}${suffix}`, { method }).then((response) => readJson<Batch | BatchTask>(response));
      let nextTaskListId = selectedBatchId;
      let nextQueryState = taskQueryStateForScope(selectedBook?.book_id, selectedBatchId);
      if ('tasks' in result) {
        nextTaskListId = result.id;
        if (result.id !== selectedBatchId) {
          nextQueryState = switchTaskScope(selectedBook?.book_id, result.id);
        } else {
          nextQueryState = taskQueryStateForScope(selectedBook?.book_id, result.id);
        }
        setSelectedBatchId(result.id);
      }
      const nextPageSize = 'tasks' in result ? taskListPageSize(result.tasks.filter((task) => task.input.book_id === selectedBook?.book_id).length) : taskPageSize;
      await loadBooks(selectedBook?.book_id);
      await loadBookBatches(selectedBook?.book_id, nextTaskListId);
      await loadBookTasks(selectedBook?.book_id, taskPage, nextTaskListId, {}, nextPageSize, nextQueryState);
      await loadRuns(task.id);
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : '任务操作失败');
    }
  }

  async function exportSelectedBatchToLark() {
    if (!selectedBatch) return;
    setError(null);
    setExporting(true);
    try {
      await fetch(`/api/batches/${selectedBatch.id}/export/lark`, { method: 'POST' }).then((response) => readJson<LarkExportResult>(response));
      await loadBookBatches(selectedBook?.book_id);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出飞书失败');
    } finally {
      setExporting(false);
    }
  }

  async function deleteSelectedBatch(batch: BookBatchSummary) {
    if (!window.confirm(`确认删除任务清单「${normalizeDisplayFileName(batch.file_name)}」？该清单下的任务将从书籍任务列表中移除。`)) return;
    setError(null);
    setDeletingBatchId(batch.id);
    try {
      await fetch(`/api/batches/${batch.id}`, { method: 'DELETE' }).then((response) => readJson<{ ok: boolean }>(response));
      const nextTaskListId = selectedBatchId === batch.id ? 'all' : selectedBatchId;
      const nextQueryState = selectedBatchId === batch.id ? switchTaskScope(selectedBook?.book_id, 'all') : taskQueryStateForScope(selectedBook?.book_id, nextTaskListId);
      if (selectedBatchId === batch.id) {
        setSelectedBatchId('all');
        setTaskPageSize(taskListPageSize());
      }
      setSelectedTaskId(null);
      await loadBooks(selectedBook?.book_id);
      await loadBookBatches(selectedBook?.book_id, nextTaskListId);
      await loadBookTasks(
        selectedBook?.book_id,
        taskPage,
        nextTaskListId,
        {},
        nextTaskListId === 'all' ? taskListPageSize() : taskPageSize,
        nextQueryState
      );
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除任务清单失败');
    } finally {
      setDeletingBatchId(null);
    }
  }

  async function saveBatchName(batch: BookBatchSummary) {
    if (editingBatchId !== batch.id) return;
    const nextName = editingBatchName.trim();
    if (!nextName) {
      setError('任务清单名称不能为空');
      return;
    }
    setError(null);
    setSavingBatchNameId(batch.id);
    try {
      await fetch(`/api/batches/${batch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName })
      }).then((response) => readJson<Batch>(response));
      setBatches((current) => current.map((item) => (item.id === batch.id ? { ...item, file_name: nextName } : item)));
      setEditingBatchId(null);
      setEditingBatchName('');
      await loadBookBatches(selectedBook?.book_id);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '修改任务清单名称失败');
    } finally {
      setSavingBatchNameId(null);
    }
  }

  function startColumnResize(columnKey: BookTaskColumnKey, clientX: number, target: HTMLButtonElement, pointerId?: number) {
    if (activeColumnResizeRef.current) return;
    activeColumnResizeRef.current = columnKey;
    if (pointerId !== undefined) {
      target.setPointerCapture(pointerId);
    }
    const startX = clientX;
    const startWidth = taskColumnWidthsRef.current[columnKey];

    function updateWidth(nextClientX: number) {
      const nextWidths = {
        ...taskColumnWidthsRef.current,
        [columnKey]: clampColumnWidth(columnKey, startWidth + nextClientX - startX)
      };
      taskColumnWidthsRef.current = nextWidths;
      setTaskColumnWidths(nextWidths);
      saveBookTaskColumnWidths(nextWidths);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      updateWidth(moveEvent.clientX);
    }

    function handlePointerUp(upEvent: PointerEvent) {
      updateWidth(upEvent.clientX);
      activeColumnResizeRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      if (pointerId !== undefined && target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    }

    function handleMouseMove(moveEvent: MouseEvent) {
      updateWidth(moveEvent.clientX);
    }

    function handleMouseUp(upEvent: MouseEvent) {
      updateWidth(upEvent.clientX);
      activeColumnResizeRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }

    if (pointerId !== undefined) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    } else {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
  }

  return (
    <div className="workspace-frame book-workspace">
      <WorkspaceSidebar
        page={page}
        onChange={onNavigate}
        difyWorkflowName={difyWorkflowName}
        bookDirectory={
          <div className="sidebar-book-list">
            {books.map((book) => (
              <button
                key={book.book_id}
                className={selectedBook?.book_id === book.book_id ? 'active' : ''}
                onClick={() => {
                  const nextPageSize = taskListPageSize(book.task_count);
                  const nextQueryState = selectedBook?.book_id !== book.book_id ? switchTaskScope(book.book_id, 'all') : taskQueryStateForScope(book.book_id, 'all');
                  setSelectedBookId(book.book_id);
                  setSelectedBatchId('all');
                  setTaskPageSize(nextPageSize);
                  setSelectedTaskId(null);
                  setTaskPage(1);
                  void loadBookTasks(book.book_id, 1, 'all', {}, nextPageSize, nextQueryState);
                }}
              >
                <strong>{book.name || `书籍 ${book.book_id}`}</strong>
                <span>{book.task_count} 任务 · {book.unfinished_count} 未完成</span>
              </button>
            ))}
            {books.length === 0 && <p className="muted">还没有书籍，请先上传 Excel 创建任务清单。</p>}
          </div>
        }
      />

      <section className="workspace-content book-content">
      {error && (
        <section className="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </section>
      )}

      {recentImportedBookIds.length > 0 && (
        <section className="imported-books-callout">
          <CheckCircle2 size={18} />
          <span>刚导入 {recentImportedBookIds.length} 本书：{recentImportedBookIds.join('、')}。可在左侧选择后命名。</span>
          <button onClick={() => setRecentImportedBookIds([])}>知道了</button>
        </section>
      )}

      <section className="batch-create-panel upload-compact-panel">
        <input
          ref={batchUploadInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadWorkbook(file);
            event.currentTarget.value = '';
          }}
        />
        <button className="secondary-action upload-only-action" onClick={() => batchUploadInputRef.current?.click()} disabled={isUploading}>
          {isUploading ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
          上传 Excel
        </button>
      </section>

      {selectedBook ? (
      <section className="books-layout book-main-grid">
        <section className="books-main main-panel">
          <div className="book-batch-strip">
            <button
              className={selectedBatchId === 'all' ? 'active' : ''}
              onClick={() => {
                const nextQueryState =
                  selectedBatchId !== 'all' ? switchTaskScope(selectedBook?.book_id, 'all') : taskQueryStateForScope(selectedBook?.book_id, 'all');
                const nextPageSize = pageSizeForScope('all');
                setSelectedBatchId('all');
                setTaskPageSize(nextPageSize);
                setTaskPage(1);
                void loadBookTasks(selectedBook?.book_id, 1, 'all', {}, nextPageSize, nextQueryState);
              }}
            >
              全部任务
              <span>{selectedBook.task_count} 条</span>
            </button>
            {batches.map((batch) => (
              <div key={batch.id} className={`batch-chip ${selectedBatchId === batch.id ? 'active' : ''}`}>
                {editingBatchId === batch.id ? (
                  <div className="batch-chip-edit">
                    <input
                      autoFocus
                      value={editingBatchName}
                      disabled={savingBatchNameId === batch.id}
                      onBlur={() => void saveBatchName(batch)}
                      onChange={(event) => setEditingBatchName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                        if (event.key === 'Escape') {
                          setEditingBatchId(null);
                          setEditingBatchName('');
                        }
                      }}
                    />
                    <span>{savingBatchNameId === batch.id ? '保存中' : '回车保存'}</span>
                  </div>
                ) : (
                  <button
                    className="batch-chip-main"
                    onClick={() => {
                      const nextPageSize = taskListPageSize(batch.task_count);
                      const nextQueryState =
                        selectedBatchId !== batch.id
                          ? switchTaskScope(selectedBook?.book_id, batch.id)
                          : taskQueryStateForScope(selectedBook?.book_id, batch.id);
                      setSelectedBatchId(batch.id);
                      setTaskPageSize(nextPageSize);
                      setTaskPage(1);
                      void loadBookTasks(selectedBook?.book_id, 1, batch.id, {}, nextPageSize, nextQueryState);
                    }}
                  >
                    {normalizeDisplayFileName(batch.file_name)}
                    <span>{batch.task_count} 条 · {batch.succeeded_count} 成功</span>
                  </button>
                )}
                <button
                  className="batch-chip-edit-button"
                  title="修改任务清单名称"
                  aria-label={`修改任务清单名称 ${normalizeDisplayFileName(batch.file_name)}`}
                  disabled={savingBatchNameId === batch.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingBatchId(batch.id);
                    setEditingBatchName(normalizeDisplayFileName(batch.file_name));
                  }}
                >
                  {savingBatchNameId === batch.id ? <Loader2 className="spin" size={13} /> : <Pencil size={13} />}
                </button>
                <button
                  className="batch-chip-delete"
                  title="删除任务清单"
                  aria-label={`删除任务清单 ${normalizeDisplayFileName(batch.file_name)}`}
                  disabled={deletingBatchId === batch.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteSelectedBatch(batch);
                  }}
                >
                  {deletingBatchId === batch.id ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                </button>
              </div>
            ))}
          </div>

          <div className="task-list-head">
            <div>
              <strong>任务列表</strong>
              <span>
                当前页 {tasks.length} 条 / 共 {taskPagination.total} 条 · 可执行 {taskPagination.runnableTotal} 条
                {selectedBatchId !== 'all' ? ' · 已选任务清单' : ' · 全部任务仅用于查询'}
              </span>
            </div>
          </div>

          {selectedBatchIsRunning && selectedBatchId !== 'all' && (
            <div className="running-batch-notice">
              <Loader2 className="spin" size={16} />
              <span>
                当前任务清单正在执行
                {runningTask ? `：第 ${runningTask.row_no} 行（${runningTask.progress_label ?? '执行中'}）` : '，正在同步执行状态'}
              </span>
              <button
                className="secondary-action"
                onClick={() => void showRunningTasks()}
              >
                查看执行中
              </button>
            </div>
          )}

          <div className="task-toolbar book-task-toolbar book-filter-panel">
            <label>
              任务状态
              <select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as StatusFilter);
                  setTaskPage(1);
                }}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={`range-filter ${isRangeFilterOpen ? 'open' : ''}`} ref={rangeFilterRef}>
              <button className="range-filter-toggle" onClick={() => setRangeFilterOpen((current) => !current)} type="button">
                范围
                <span>{rangeFilterSummary}</span>
                {isRangeFilterOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {isRangeFilterOpen && (
                <div className="range-filter-popover">
                  <label>
                    筛选维度
                    <select
                      value={rangeFilterMode}
                      onChange={(event) => {
                        const nextMode = event.target.value as RangeFilterMode;
                        setRangeFilterMode(nextMode);
                        setTaskPage(1);
                        if (nextMode === 'chapter') {
                          setRowNoFrom('');
                          setRowNoTo('');
                        } else {
                          setChapterFrom('');
                          setChapterTo('');
                        }
                      }}
                    >
                      <option value="chapter">章节范围</option>
                      <option value="row">行数范围</option>
                    </select>
                  </label>
                  <div className="range-filter-fields">
                    <label>
                      {rangeFilterMode === 'chapter' ? '章节从' : '行数从'}
                      <input
                        value={rangeFilterMode === 'chapter' ? chapterFrom : rowNoFrom}
                        onChange={(event) => {
                          if (rangeFilterMode === 'chapter') {
                            setChapterFrom(event.target.value);
                          } else {
                            setRowNoFrom(event.target.value);
                          }
                          setTaskPage(1);
                        }}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      {rangeFilterMode === 'chapter' ? '章节到' : '行数到'}
                      <input
                        value={rangeFilterMode === 'chapter' ? chapterTo : rowNoTo}
                        onChange={(event) => {
                          if (rangeFilterMode === 'chapter') {
                            setChapterTo(event.target.value);
                          } else {
                            setRowNoTo(event.target.value);
                          }
                          setTaskPage(1);
                        }}
                        inputMode="numeric"
                      />
                    </label>
                  </div>
                  <div className="range-filter-actions">
                    <button className="secondary-action" type="button" onClick={() => void clearRangeFilterSearch()}>
                      清空范围
                    </button>
                    <button className="generate-filter-button" type="button" onClick={() => void applyRangeFilterSearch()}>
                      应用范围
                    </button>
                  </div>
                </div>
              )}
            </div>
            <label>
              图片
              <select
                value={hasImage}
                onChange={(event) => {
                  setHasImage(event.target.value as ImagePresenceFilter);
                  setTaskPage(1);
                }}
              >
                {IMAGE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              价值
              <select
                value={valueStatus}
                onChange={(event) => {
                  setValueStatus(event.target.value as ValueStatusFilter);
                  setTaskPage(1);
                }}
              >
                {VALUE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              搜索任务
              <input
                value={taskQuery}
                onChange={(event) => {
                  setTaskQuery(event.target.value);
                  setTaskPage(1);
                }}
                onKeyDown={(event) => event.key === 'Enter' && void searchTasks()}
                placeholder="段落 / 标题 / 错误 / 章节"
              />
            </label>
            <div className="filter-action-row">
              <button className="generate-filter-button" onClick={() => void searchTasks()} disabled={!selectedBook || isLoadingTasks}>
                {isLoadingTasks ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                查询
              </button>
              <button
                className="continue-filter-button secondary-action"
                onClick={() => void continueTasks()}
                disabled={!selectedBook || !selectedBatch || isAllTaskListView || selectedBatchIsRunning || isContinuing || taskPagination.runnableTotal === 0}
                title={
                  !selectedBatch || isAllTaskListView
                    ? '请先选择一个上传文档任务清单后再执行生图'
                    : selectedBatchIsRunning
                      ? '当前任务清单正在执行中'
                      : `按当前任务列表范围执行：${continueScopeText}。改了筛选后请先点“查询”，已成功任务会重新生成并保留历史记录`
                }
              >
                {isContinuing ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                执行生图
              </button>
              <button
                className="export-filter-button secondary-action"
                onClick={() => void exportSelectedBatchToLark()}
                disabled={!selectedBatch || isExporting}
                title={!selectedBatch ? '请先选择一个上传文档任务清单后再导出' : undefined}
              >
                {isExporting ? <Loader2 className="spin" size={16} /> : <Database size={16} />}
                导出飞书
              </button>
            </div>
          </div>

          <div className="task-table-wrap book-task-table-wrap">
            <table className="task-table book-task-table" style={{ minWidth: taskTableMinWidth }}>
              <colgroup>
                {BOOK_TASK_COLUMN_CONFIG.map((column) => (
                  <col key={column.key} style={{ width: taskColumnWidths[column.key] }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {BOOK_TASK_COLUMN_CONFIG.map((column) => (
                    <ResizableTableHeader column={column} key={column.key} onResizeStart={startColumnResize} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className={selectedTask?.id === task.id ? 'selected' : ''} onClick={() => setSelectedTaskId(task.id)}>
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
                        <span>章 {task.input.chapter_sort || '-'} · {task.batch_id ? '文档' : '手动'}</span>
                      </div>
                    </td>
                    <td>
                      <RawValue value={task.is_valid} />
                    </td>
                    <td className="paragraph-column">
                      <div className="paragraph-cell">
                        <p>{truncate(task.input.paragraph_content, 150)}</p>
                      </div>
                    </td>
                    <td>
                      <div className="result-cell">
                        <strong>{task.title || '暂无标题'}</strong>
                        <span>{task.elapsed_seconds ? `${task.elapsed_seconds}s` : statusLabel[task.status]}</span>
                      </div>
                    </td>
                    <td>
                      <TaskActions task={task} onAction={(action) => void storedTaskAction(task, action)} />
                    </td>
                  </tr>
                ))}
                {tasks.length === 0 && (
                  <tr>
                    <td className="table-empty" colSpan={7}>
                      当前书籍没有匹配任务。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="task-pagination">
            <div className="pagination-summary">
              第 {taskPagination.page} / {taskPagination.totalPages} 页
            </div>
            <label>
              每页
              <select
                value={taskPageSize}
                onChange={(event) => {
                  const nextPageSize = Number(event.target.value) as TaskPageSize;
                  setTaskPageSize(nextPageSize);
                  setTaskPage(1);
                }}
              >
                {TASK_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option} 条
                  </option>
                ))}
              </select>
            </label>
            <div className="pagination-actions">
              <button
                className="secondary-action"
                disabled={isLoadingTasks || taskPagination.page <= 1}
                onClick={() => setTaskPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <button
                className="secondary-action"
                disabled={isLoadingTasks || taskPagination.page >= taskPagination.totalPages}
                onClick={() => setTaskPage((current) => Math.min(taskPagination.totalPages, current + 1))}
              >
                下一页
              </button>
            </div>
          </div>
        </section>

        <aside className="books-detail right-panel">
          <div className="panel-section result-panel">
            <div className="panel-heading">
              <ImageIcon size={18} />
              <span>任务详情</span>
            </div>
            {selectedTask ? (
              <div className="result-body">
                <div className="detail-task-head">
                  <div>
                    <div className={`status-pill ${selectedTask.status}`}>
                      {statusIcon(selectedTask.status)}
                      第 {selectedTask.row_no} 行 · {statusLabel[selectedTask.status]}
                    </div>
                    <small>
                      章节 {selectedTask.input.chapter_sort || '-'} · {selectedTask.batch_id ? '文档任务' : '手动任务'}
                    </small>
                  </div>
                  <TaskActions task={selectedTask} onAction={(action) => void storedTaskAction(selectedTask, action)} />
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
                    {selectedTask.elapsed_seconds ? <span>耗时：{selectedTask.elapsed_seconds}s</span> : null}
                  </div>
                </div>
                {selectedTask.paragraph_description && (
                  <div className="description-output">
                    <strong>生图描述</strong>
                    <p>{selectedTask.paragraph_description}</p>
                  </div>
                )}
                <p className="detail-paragraph">{selectedTask.input.paragraph_content}</p>
                {selectedTask.error && <div className="task-error">{selectedTask.error}</div>}
              </div>
            ) : (
              <p className="muted">选择任务后查看详情。</p>
            )}
          </div>

          <div className="panel-section event-panel">
            <div className="panel-heading">
              <div className="panel-heading-title">
                <RefreshCw size={18} />
                <span>执行记录</span>
                <small>{runs.length} 条</small>
              </div>
              <button className="ghost-toggle" onClick={() => setRunLogOpen((current) => !current)}>
                {isRunLogOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                {isRunLogOpen ? '收起' : '展开'}
              </button>
            </div>
            {isRunLogOpen && (
              <div className="run-list">
                {compareRuns.length === 2 && (
                  <div className="run-compare-panel">
                    {compareRuns.map((run) => (
                      <section className="run-compare-card" key={run.id}>
                        <header>
                          <strong>{runTitle(run)}</strong>
                          <small>{new Date(run.created_at).toLocaleString()}</small>
                        </header>
                        {run.result_files[0] ? (
                          <button className="run-thumb-button" onClick={() => setLightboxFile(run.result_files[0])}>
                            <img src={absolutePreviewUrl(run.result_files[0].previewUrl)} alt={run.result_files[0].name} />
                          </button>
                        ) : (
                          <div className="run-thumb-empty">暂无图片</div>
                        )}
                        <div className="run-compare-meta">
                          <span>is_valid：{runIsValid(run)}</span>
                          <span>{run.elapsed_seconds ? `耗时 ${run.elapsed_seconds}s` : '耗时 -'}</span>
                        </div>
                      </section>
                    ))}
                  </div>
                )}
                {runs.map((run, index) => (
                  <div className={`run-item ${run.status} ${compareRunIds.includes(run.id) ? 'selected' : ''}`} key={run.id}>
                    <div className="run-item-head">
                      <strong>记录 {runs.length - index} · 第 {run.attempt_no} 次尝试 · {statusLabel[run.status]}</strong>
                      <time>{new Date(run.created_at).toLocaleString()}</time>
                    </div>
                    <div className="run-item-meta">
                      <span>{run.elapsed_seconds ? `${run.elapsed_seconds}s` : '-'}</span>
                      <span>is_valid：{runIsValid(run)}</span>
                    </div>
                    <p className="run-item-title">{runTitle(run)}</p>
                    {runDescription(run) && <p>{runDescription(run)}</p>}
                    {run.result_files[0] ? (
                      <button className="run-thumb-button" onClick={() => setLightboxFile(run.result_files[0])}>
                        <img src={absolutePreviewUrl(run.result_files[0].previewUrl)} alt={run.result_files[0].name} />
                      </button>
                    ) : (
                      <div className="run-thumb-empty">暂无图片</div>
                    )}
                    {run.error && <p>{run.error}</p>}
                    <div className="run-item-actions">
                      <button className="secondary-action" onClick={() => toggleRunCompare(run.id)}>
                        {compareRunIds.includes(run.id) ? '取消对比' : '加入对比'}
                      </button>
                    </div>
                  </div>
                ))}
                {runs.length === 0 && <p className="muted">还没有执行记录。</p>}
              </div>
            )}
          </div>
        </aside>
      </section>
      ) : (
        <div className="empty-state">
          <BookOpen size={40} />
          <h2>从左侧选择或新建一本书</h2>
          <p>上传 Excel 后，系统会按 bookid 自动归档到书籍库。</p>
        </div>
      )}

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
      </section>
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
  const [qualityPage, setQualityPage] = useState(1);
  const [qualityPageSize, setQualityPageSize] = useState<QualityPageSize>(50);
  const [selectedPromptVersionIds, setSelectedPromptVersionIds] = useState<Set<string>>(() => new Set());
  const [isUploading, setUploading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [isRunning, setRunning] = useState(false);
  const [isCalibrating, setCalibrating] = useState(false);
  const [loadingExperimentId, setLoadingExperimentId] = useState<string | null>(null);
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
  const qualityTotalPages = Math.max(1, Math.ceil((experiment?.records.length ?? 0) / qualityPageSize));
  const currentQualityPage = Math.min(Math.max(1, qualityPage), qualityTotalPages);
  const qualityPageStart = experiment ? (currentQualityPage - 1) * qualityPageSize : 0;
  const qualityPageEnd = experiment ? Math.min(qualityPageStart + qualityPageSize, experiment.records.length) : 0;
  const paginatedQualityRecords = useMemo(
    () => experiment?.records.slice(qualityPageStart, qualityPageEnd) ?? [],
    [experiment, qualityPageEnd, qualityPageStart]
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

  const qualityTaskItems = useMemo(() => buildQualityTaskItems(qualityState?.experiments ?? []), [qualityState?.experiments]);
  const visibleQualityTasks = qualityTaskItems.slice(0, 3);

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
          setQualityPage(1);
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

  async function loadQualityExperiment(experimentId: string) {
    if (experiment?.id === experimentId) return;
    setError(null);
    setLoadingExperimentId(experimentId);
    try {
      const nextExperiment = await fetch(`/api/quality/experiments/${experimentId}`).then((response) =>
        readJson<QualityExperiment>(response)
      );
      setExperiment(nextExperiment);
      setQualityPage(1);
      setSelectedRecordId(nextExperiment.records[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载质量任务失败');
    } finally {
      setLoadingExperimentId(null);
    }
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
      setQualityPage(1);
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
      setQualityPage(1);
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

  function selectQualityPage(page: number) {
    if (!experiment) return;
    const nextPage = Math.min(Math.max(1, page), qualityTotalPages);
    const nextRecord = experiment.records[(nextPage - 1) * qualityPageSize];
    setQualityPage(nextPage);
    if (nextRecord) setSelectedRecordId(nextRecord.id);
  }

  function changeQualityPageSize(pageSize: QualityPageSize) {
    const firstRecord = experiment?.records[0];
    setQualityPageSize(pageSize);
    setQualityPage(1);
    if (firstRecord) setSelectedRecordId(firstRecord.id);
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

          <div className="panel-section quality-task-panel">
            <div className="panel-heading">
              <Database size={18} />
              <span>任务管理</span>
            </div>
            {visibleQualityTasks.length > 0 ? (
              <div className="quality-task-list">
                {visibleQualityTasks.map((item) => (
                  <button
                    className={`quality-task-item ${experiment?.id === item.id ? 'active' : ''}`}
                    key={item.id}
                    onClick={() => void loadQualityExperiment(item.id)}
                  >
                    <span className={`status-dot ${item.status}`} />
                    <span className="quality-task-content">
                      <strong>{item.taskName}</strong>
                      <small>
                        {item.recordCount} 条 · {qualityStatusLabel[item.status]} · {formatCompactDateTime(item.createdAt)}
                      </small>
                    </span>
                    {loadingExperimentId === item.id && <Loader2 className="spin" size={15} />}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">创建测试记录后，会在这里显示最近 3 个任务。</p>
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
                    {paginatedQualityRecords.map((record) => (
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
                    {paginatedQualityRecords.length === 0 && (
                      <tr>
                        <td className="table-empty" colSpan={experiment.promptVersionIds.length + 3}>
                          当前测试记录没有段落。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="task-pagination quality-pagination">
                <div className="pagination-summary">
                  {experiment.records.length > 0
                    ? `第 ${qualityPageStart + 1}-${qualityPageEnd} / ${experiment.records.length} 条 · 第 ${currentQualityPage} / ${qualityTotalPages} 页`
                    : '0 条'}
                </div>
                <label>
                  每页
                  <select
                    value={qualityPageSize}
                    onChange={(event) => changeQualityPageSize(Number(event.target.value) as QualityPageSize)}
                  >
                    {QUALITY_PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option} 条
                      </option>
                    ))}
                  </select>
                </label>
                <div className="pagination-actions">
                  <button
                    className="secondary-action"
                    disabled={currentQualityPage <= 1}
                    onClick={() => selectQualityPage(currentQualityPage - 1)}
                  >
                    上一页
                  </button>
                  <button
                    className="secondary-action"
                    disabled={currentQualityPage >= qualityTotalPages}
                    onClick={() => selectQualityPage(currentQualityPage + 1)}
                  >
                    下一页
                  </button>
                </div>
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
