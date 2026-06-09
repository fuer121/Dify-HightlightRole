import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Database,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  Upload,
  UserRound
} from 'lucide-react';

type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';
type CharacterGenerationFilter = 'all' | 'not_generated' | 'failed' | 'running' | 'generated';

interface CharacterColumnMapping {
  novel_name: string;
  chapter_sort: string;
  chapter_name: string;
  paragraph_content: string;
  paragraph_image_url: string;
  role_name: string;
}

interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
  previewRows: Record<string, unknown>[];
  rowCount: number;
  autoMapping: Record<string, string>;
  characterAutoMapping?: Partial<CharacterColumnMapping>;
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

interface CharacterTask {
  id: string;
  job_id: string;
  row_no: number;
  input: {
    novel_name: string;
    chapter_sort: number;
    chapter_name: string;
    paragraph_content: string;
    paragraph_image_url: string;
    role_name: string;
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
  extracted_role_name?: string;
  extracted_description?: string;
  portrait_files: ResultFile[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

interface CharacterJobSummary {
  id: string;
  file_name: string;
  sheet_name: string;
  status: 'idle' | 'running' | 'paused' | 'completed';
  created_at: string;
  updated_at: string;
  task_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  paused_count: number;
}

interface CharacterJob extends CharacterJobSummary {
  workbookId: string;
  sheetName: string;
  fileName: string;
  mapping: CharacterColumnMapping;
  promptText: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  tasks: CharacterTask[];
  events: Array<{ id: string; type: 'info' | 'error' | 'task'; message: string; createdAt: string; taskId?: string }>;
}

interface CharacterTaskRunRecord {
  id: string;
  task_id: string;
  attempt_no: number;
  status: TaskStatus;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds?: number;
  workflow_run_id?: string;
  dify_task_id?: string;
  extracted_role_name?: string;
  extracted_description?: string;
  portrait_files: ResultFile[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
  created_at: string;
}

interface HealthPayload {
  config?: {
    hasCharacterDifyApiKey?: boolean;
    characterDifyWorkflowName?: string | null;
  };
}

const CHARACTER_REQUIRED_FIELDS: Array<{ key: keyof CharacterColumnMapping; label: string }> = [
  { key: 'novel_name', label: '小说名' },
  { key: 'chapter_sort', label: '章节序号' },
  { key: 'chapter_name', label: '章节名' },
  { key: 'paragraph_content', label: '段落内容' },
  { key: 'paragraph_image_url', label: '段落图片（CDN 链接）' },
  { key: 'role_name', label: '角色名' }
];

const DEFAULT_CHARACTER_PROMPT = `请把段落图片作为角色参考图，而不是抠图素材，基于图中主要人物重新绘制一张可作为人物设定图使用的白底立绘。要求：
1. 保留原图人物的核心可识别特征：性别年龄感、发型、五官气质、服饰结构、重要配饰和角色状态。
2. 不要直接裁切、抠出或复刻原图人物；需要重新绘制成干净的角色设定立绘。
3. 立绘为单人、纯白背景、全身或大半身完整构图，正面或三分之二侧面，人物居中，边缘清晰。
4. 去掉原场景背景、复杂光影、剧情动作、水面/山谷/建筑等环境元素，只保留角色设计本身。
5. 如果图片中有多个人物，请以给定角色名或画面主角为主体，避免多人群像。
6. 输出人物名称、用于重绘的外观设定描述，以及最终立绘图片。`;

const statusLabel: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  paused: '已暂停'
};

const generationStatusOptions: Array<{ value: CharacterGenerationFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'not_generated', label: '未生成' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '生成中' },
  { value: 'generated', label: '已生成' }
];

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

function truncate(text: string, length = 120) {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function normalizeDisplayFileName(fileName: string) {
  return fileName;
}

function splitRoleCandidates(roleName: string) {
  return roleName
    .split(/[,，、/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function absolutePreviewUrl(url: string) {
  return url;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function CharacterExtractionPage({ difyWorkflowName }: { difyWorkflowName: string }) {
  const [health, setHealth] = useState<HealthPayload['config'] | null>(null);
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [mapping, setMapping] = useState<Partial<CharacterColumnMapping>>({});
  const [promptText, setPromptText] = useState(DEFAULT_CHARACTER_PROMPT);
  const [jobPromptDraft, setJobPromptDraft] = useState(DEFAULT_CHARACTER_PROMPT);
  const [jobs, setJobs] = useState<CharacterJobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<CharacterJob | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskRuns, setTaskRuns] = useState<CharacterTaskRunRecord[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [includeRoleFilter, setIncludeRoleFilter] = useState('');
  const [excludedRoleFilters, setExcludedRoleFilters] = useState<string[]>([]);
  const [excludeRoleSearch, setExcludeRoleSearch] = useState('');
  const [novelFilter, setNovelFilter] = useState('');
  const [generationFilter, setGenerationFilter] = useState<CharacterGenerationFilter>('all');
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [isUploading, setUploading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [isStarting, setStarting] = useState(false);
  const [isPausing, setPausing] = useState(false);
  const [isSavingPrompt, setSavingPrompt] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedSheet = useMemo(
    () => workbook?.sheets.find((sheet) => sheet.name === selectedSheetName) ?? null,
    [selectedSheetName, workbook]
  );

  const selectedTask = useMemo(
    () => job?.tasks.find((task) => task.id === selectedTaskId) ?? job?.tasks[0] ?? null,
    [job, selectedTaskId]
  );
  const visibleJobs = jobs.slice(0, 3);
  const novelOptions = useMemo(() => {
    if (!job) return [];
    return Array.from(new Set(job.tasks.map((task) => task.input.novel_name).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [job]);
  const roleCandidateOptions = useMemo(() => {
    if (!job) return [];
    return Array.from(new Set(job.tasks.flatMap((task) => splitRoleCandidates(task.input.role_name)))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [job]);
  const visibleRoleCandidateOptions = useMemo(() => {
    const keyword = excludeRoleSearch.trim().toLowerCase();
    if (!keyword) return roleCandidateOptions;
    return roleCandidateOptions.filter((roleName) => roleName.toLowerCase().includes(keyword));
  }, [excludeRoleSearch, roleCandidateOptions]);
  const filteredTasks = useMemo(() => {
    if (!job) return [];
    const includeRole = includeRoleFilter.trim().toLowerCase();
    const excludedRoles = new Set(excludedRoleFilters.map((roleName) => roleName.toLowerCase()));
    return job.tasks.filter((task) => {
      const roleName = task.input.role_name.toLowerCase();
      const taskRoleCandidates = splitRoleCandidates(task.input.role_name).map((role) => role.toLowerCase());
      if (includeRole && !roleName.includes(includeRole)) return false;
      if (taskRoleCandidates.some((role) => excludedRoles.has(role))) return false;
      if (novelFilter && task.input.novel_name !== novelFilter) return false;
      if (generationFilter === 'generated') return task.status === 'succeeded';
      if (generationFilter === 'failed') return task.status === 'failed';
      if (generationFilter === 'running') return task.status === 'running';
      if (generationFilter === 'not_generated') return task.status === 'queued' || task.status === 'paused';
      return true;
    });
  }, [excludedRoleFilters, generationFilter, includeRoleFilter, job, novelFilter]);
  const selectedTaskIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const filteredTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks]);
  const selectedVisibleTaskIds = useMemo(
    () => selectedTaskIds.filter((taskId) => filteredTaskIds.includes(taskId)),
    [filteredTaskIds, selectedTaskIds]
  );
  const areAllFilteredTasksSelected =
    filteredTaskIds.length > 0 && filteredTaskIds.every((taskId) => selectedTaskIdSet.has(taskId));

  useEffect(() => {
    fetch('/api/health')
      .then((response) => readJson<HealthPayload>(response))
      .then((payload) => {
        setHealth(payload.config ?? null);
        if (payload.config?.characterDifyWorkflowName) {
          setPromptText(DEFAULT_CHARACTER_PROMPT);
        }
      })
      .catch(() => undefined);
  }, []);

  const refreshJobs = useCallback(async (preferredJobId?: string) => {
    const payload = await fetch('/api/character-jobs').then((response) => readJson<{ jobs: CharacterJobSummary[] }>(response));
    setJobs(payload.jobs);
    const nextSelectedId = preferredJobId ?? selectedJobId ?? payload.jobs[0]?.id ?? null;
    setSelectedJobId(nextSelectedId);
    if (nextSelectedId) {
      const detail = await fetch(`/api/character-jobs/${nextSelectedId}`).then((response) => readJson<CharacterJob>(response));
      setJob(detail);
      setJobPromptDraft(detail.promptText || DEFAULT_CHARACTER_PROMPT);
      setSelectedTaskId((current) => current ?? detail.tasks[0]?.id ?? null);
    } else {
      setJob(null);
      setJobPromptDraft(DEFAULT_CHARACTER_PROMPT);
      setSelectedTaskId(null);
    }
  }, [selectedJobId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshJobs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshJobs]);

  useEffect(() => {
    if (!selectedJobId) return;
    const source = new EventSource(`/api/character-jobs/${selectedJobId}/events`);
    source.onmessage = (event) => {
      const nextJob = JSON.parse(event.data) as CharacterJob;
      setJob(nextJob);
      setSelectedTaskId((current) => current ?? nextJob.tasks[0]?.id ?? null);
      setJobs((current) =>
        current.map((item) =>
          item.id === nextJob.id
            ? {
                ...item,
                status: nextJob.status,
                task_count: nextJob.tasks.length,
                queued_count: nextJob.tasks.filter((task) => task.status === 'queued').length,
                running_count: nextJob.tasks.filter((task) => task.status === 'running').length,
                succeeded_count: nextJob.tasks.filter((task) => task.status === 'succeeded').length,
                failed_count: nextJob.tasks.filter((task) => task.status === 'failed').length,
                paused_count: nextJob.tasks.filter((task) => task.status === 'paused').length,
                updated_at: nextJob.updatedAt
              }
            : item
        )
      );
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedTask?.id) return;
    fetch(`/api/character-tasks/${selectedTask.id}/runs`)
      .then((response) => readJson<{ runs: CharacterTaskRunRecord[] }>(response))
      .then((payload) => setTaskRuns(payload.runs))
      .catch(() => setTaskRuns([]));
  }, [selectedTask?.id]);

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
      setMapping(firstSheet?.characterAutoMapping ?? {});
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function createJob() {
    if (!workbook || !selectedSheet || CHARACTER_REQUIRED_FIELDS.some((field) => !mapping[field.key])) return;
    setError(null);
    setCreating(true);
    try {
      const nextJob = await fetch('/api/character-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workbookId: workbook.id,
          sheetName: selectedSheet.name,
          mapping,
          promptText
        })
      }).then((response) => readJson<CharacterJob>(response));
      setSelectedJobId(nextJob.id);
      setJob(nextJob);
      setJobPromptDraft(nextJob.promptText || DEFAULT_CHARACTER_PROMPT);
      setSelectedTaskId(nextJob.tasks[0]?.id ?? null);
      await refreshJobs(nextJob.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建角色任务失败');
    } finally {
      setCreating(false);
    }
  }

  async function startTasks(taskIds: string[], nextSelectedTaskId?: string) {
    if (!job) return;
    if (taskIds.length === 0) {
      setError('当前筛选范围没有可执行任务');
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const activeJob = await saveJobPromptIfNeeded();
      const nextJob = await fetch(`/api/character-jobs/${job.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds })
      }).then((response) => readJson<CharacterJob>(response));
      setJob({ ...nextJob, promptText: nextJob.promptText || activeJob.promptText });
      setSelectedTaskId(nextSelectedTaskId ?? taskIds[0] ?? nextJob.tasks[0]?.id ?? null);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '启动角色任务失败');
    } finally {
      setStarting(false);
    }
  }

  async function saveJobPromptIfNeeded() {
    if (!job) throw new Error('角色任务不存在');
    const nextPrompt = jobPromptDraft.trim();
    if (!nextPrompt) throw new Error('Prompt 不能为空');
    if (nextPrompt === job.promptText.trim()) return job;
    const nextJob = await fetch(`/api/character-jobs/${job.id}/prompt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: nextPrompt })
    }).then((response) => readJson<CharacterJob>(response));
    setJob(nextJob);
    setJobPromptDraft(nextJob.promptText || nextPrompt);
    return nextJob;
  }

  async function saveJobPrompt() {
    if (!job) return;
    setError(null);
    setSavingPrompt(true);
    try {
      await saveJobPromptIfNeeded();
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : '保存 Prompt 失败');
    } finally {
      setSavingPrompt(false);
    }
  }

  async function startJob() {
    await startTasks(filteredTaskIds);
  }

  async function startSelectedTasks() {
    await startTasks(selectedVisibleTaskIds, selectedVisibleTaskIds[0]);
  }

  async function startSingleTask(taskId: string) {
    await startTasks([taskId], taskId);
  }

  async function pauseJob() {
    if (!job) return;
    setError(null);
    setPausing(true);
    try {
      const nextJob = await fetch(`/api/character-jobs/${job.id}/pause`, { method: 'POST' }).then((response) =>
        readJson<CharacterJob>(response)
      );
      setJob(nextJob);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : '暂停角色任务失败');
    } finally {
      setPausing(false);
    }
  }

  function toggleTaskSelection(taskId: string, checked: boolean) {
    setSelectedTaskIds((current) => (checked ? Array.from(new Set([...current, taskId])) : current.filter((id) => id !== taskId)));
  }

  function toggleFilteredTaskSelection(checked: boolean) {
    setSelectedTaskIds((current) => {
      if (checked) return Array.from(new Set([...current, ...filteredTaskIds]));
      const filteredTaskIdSet = new Set(filteredTaskIds);
      return current.filter((taskId) => !filteredTaskIdSet.has(taskId));
    });
  }

  async function retryTask(taskId: string) {
    if (!job) return;
    setError(null);
    setRetryingTaskId(taskId);
    try {
      const nextJob = await fetch(`/api/character-jobs/${job.id}/tasks/${taskId}/retry`, { method: 'POST' }).then((response) =>
        readJson<CharacterJob>(response)
      );
      setJob(nextJob);
      setSelectedTaskId(taskId);
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : '重试失败');
    } finally {
      setRetryingTaskId(null);
    }
  }

  return (
    <>
      {error && (
        <section className="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </section>
      )}

      <section className="quality-layout character-layout">
        <aside className="left-panel quality-left">
          <div className="panel-section character-upload-panel">
            <div className="panel-heading character-panel-heading">
              <FileSpreadsheet size={18} />
              <span>上传与映射</span>
            </div>
            <button className="drop-button" onClick={() => inputRef.current?.click()} disabled={isUploading}>
              {isUploading ? <Loader2 className="spin" size={22} /> : <Upload size={22} />}
              选择 Excel 或 CSV
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
            {workbook && (
              <>
                <div className="file-name">{normalizeDisplayFileName(workbook.fileName)}</div>
                <label className="field-label">
                  工作表
                  <select value={selectedSheetName} onChange={(event) => setSelectedSheetName(event.target.value)}>
                    {workbook.sheets.map((sheet) => (
                      <option key={sheet.name} value={sheet.name}>
                        {sheet.name} · {sheet.rowCount} 行
                      </option>
                    ))}
                  </select>
                </label>
                {CHARACTER_REQUIRED_FIELDS.map((field) => (
                  <label className="field-label" key={field.key}>
                    {field.label}
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}
                    >
                      <option value="">选择列</option>
                      {selectedSheet?.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className="field-label">
                  Prompt
                  <textarea
                    className="character-prompt-input"
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                    rows={10}
                  />
                </label>
                <button
                  className="wide-button"
                  onClick={() => void createJob()}
                  disabled={
                    isCreating ||
                    !selectedSheet ||
                    CHARACTER_REQUIRED_FIELDS.some((field) => !mapping[field.key]) ||
                    !promptText.trim()
                  }
                >
                  {isCreating ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  创建角色任务
                </button>
                {health && (
                  <p className="field-hint">
                    角色提取工作流：{health.characterDifyWorkflowName || difyWorkflowName}
                    {health.hasCharacterDifyApiKey ? ' · 已配置' : ' · 未配置'}
                  </p>
                )}
              </>
            )}
          </div>

          {job && (
            <div className="panel-section character-execution-panel">
              <div className="panel-heading character-panel-heading">
                <Play size={18} />
                <span>执行范围</span>
              </div>
              <div className="character-execution-summary">
                <strong>{normalizeDisplayFileName(job.fileName)}</strong>
                <span>{job.sheetName}</span>
                <span>总计 {job.tasks.length} 条</span>
                <span>当前筛选命中 {filteredTasks.length} 条</span>
              </div>
              <label className="field-label character-job-prompt">
                当前任务 Prompt
                <textarea
                  className="character-prompt-input"
                  value={jobPromptDraft}
                  onChange={(event) => setJobPromptDraft(event.target.value)}
                  rows={7}
                />
              </label>
              <button
                className="secondary-action"
                onClick={() => void saveJobPrompt()}
                disabled={isSavingPrompt || !jobPromptDraft.trim() || jobPromptDraft.trim() === job.promptText.trim()}
              >
                {isSavingPrompt ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                保存当前 Prompt
              </button>
              <button
                className="wide-button character-execution-button"
                onClick={() => void startJob()}
                disabled={isStarting || !health?.hasCharacterDifyApiKey || filteredTasks.length === 0}
              >
                {isStarting ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                执行提取
              </button>
              <div className="character-execution-actions">
                <button
                  className="secondary-action"
                  onClick={() => void startSelectedTasks()}
                  disabled={isStarting || !health?.hasCharacterDifyApiKey || selectedVisibleTaskIds.length === 0}
                >
                  {isStarting ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  执行已选 {selectedVisibleTaskIds.length} 条
                </button>
                <button className="secondary-action" onClick={() => void pauseJob()} disabled={isPausing || job.status !== 'running'}>
                  {isPausing ? <Loader2 className="spin" size={14} /> : <PauseCircle size={14} />}
                  暂停整体任务
                </button>
              </div>
              <p className="field-hint">执行范围以右侧当前筛选列表为准。</p>
            </div>
          )}

          <div className="panel-section quality-task-panel character-history-panel">
            <div className="panel-heading character-panel-heading">
              <Database size={18} />
              <span>历史任务</span>
              {jobs.length > 3 && <small>最新 3 个</small>}
            </div>
            {jobs.length > 0 ? (
              <div className="quality-task-list character-history-list">
                {visibleJobs.map((item) => (
                  <button
                    className={`quality-task-item ${selectedJobId === item.id ? 'active' : ''}`}
                    key={item.id}
                    onClick={() => void refreshJobs(item.id)}
                  >
                    <span className={`status-dot ${item.status}`} />
                    <span className="quality-task-content">
                      <strong>{normalizeDisplayFileName(item.file_name)}</strong>
                      <small>
                        {item.task_count} 条 · {statusLabel[item.status as TaskStatus] ?? item.status} · {formatDateTime(item.updated_at)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">还没有角色提取任务。</p>
            )}
          </div>
        </aside>

        <section className="quality-main main-panel">
          <div className="stats-row">
            <Stat label="总任务" value={job?.tasks.length ?? 0} />
            <Stat label="成功" value={job?.tasks.filter((task) => task.status === 'succeeded').length ?? 0} tone="success" />
            <Stat label="失败" value={job?.tasks.filter((task) => task.status === 'failed').length ?? 0} tone="danger" />
            <Stat label="执行中" value={job?.tasks.filter((task) => task.status === 'running').length ?? 0} />
          </div>

          {job ? (
            <div className="task-surface">
              <div className="character-filter-bar">
                <label>
                  筛选角色
                  <input
                    value={includeRoleFilter}
                    onChange={(event) => setIncludeRoleFilter(event.target.value)}
                    placeholder="输入角色名"
                  />
                </label>
                <div className="character-filter-field">
                  <span>排除角色</span>
                  <details className="character-role-select">
                    <summary>{excludedRoleFilters.length > 0 ? `已排除 ${excludedRoleFilters.length} 个` : '选择排除角色'}</summary>
                    <div className="character-role-menu">
                      <input
                        className="character-role-search"
                        value={excludeRoleSearch}
                        onChange={(event) => setExcludeRoleSearch(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        placeholder="搜索排除角色"
                      />
                      {visibleRoleCandidateOptions.length > 0 ? (
                        visibleRoleCandidateOptions.map((roleName) => (
                          <label className="character-role-option" key={roleName}>
                            <input
                              type="checkbox"
                              aria-label={`排除角色 ${roleName}`}
                              checked={excludedRoleFilters.includes(roleName)}
                              onChange={(event) => {
                                setExcludedRoleFilters((current) =>
                                  event.target.checked ? [...current, roleName] : current.filter((item) => item !== roleName)
                                );
                              }}
                            />
                            <span>{roleName}</span>
                          </label>
                        ))
                      ) : (
                        <span className="character-role-empty">{roleCandidateOptions.length > 0 ? '没有匹配角色' : '暂无角色候选'}</span>
                      )}
                    </div>
                  </details>
                </div>
                <label>
                  书籍
                  <select value={novelFilter} onChange={(event) => setNovelFilter(event.target.value)}>
                    <option value="">全部书籍</option>
                    {novelOptions.map((novelName) => (
                      <option key={novelName} value={novelName}>
                        {novelName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  立绘状态
                  <select value={generationFilter} onChange={(event) => setGenerationFilter(event.target.value as CharacterGenerationFilter)}>
                    {generationStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="quality-table-wrap">
                <table className="task-table character-table">
                  <thead>
                    <tr>
                      <th className="character-select-cell">
                        <input
                          type="checkbox"
                          aria-label="选择当前筛选任务"
                          checked={areAllFilteredTasksSelected}
                          onChange={(event) => toggleFilteredTaskSelection(event.target.checked)}
                        />
                      </th>
                      <th>状态</th>
                      <th>段落图</th>
                      <th>小说名</th>
                      <th>章节</th>
                      <th>章节名</th>
                      <th>角色名</th>
                      <th>段落内容</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTasks.map((task) => (
                      <tr key={task.id} className={selectedTask?.id === task.id ? 'selected' : ''} onClick={() => setSelectedTaskId(task.id)}>
                        <td className="character-select-cell">
                          <input
                            type="checkbox"
                            aria-label={`选择第 ${task.row_no} 行`}
                            checked={selectedTaskIdSet.has(task.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleTaskSelection(task.id, event.target.checked)}
                          />
                        </td>
                        <td>{statusLabel[task.status]}</td>
                        <td>
                          <button className="inline-image-button" onClick={(event) => { event.stopPropagation(); setLightboxUrl(task.input.paragraph_image_url); }}>
                            <img src={task.input.paragraph_image_url} alt={`${task.input.role_name} 场景图`} />
                          </button>
                        </td>
                        <td>{task.input.novel_name}</td>
                        <td>{task.input.chapter_sort}</td>
                        <td>{truncate(task.input.chapter_name, 24)}</td>
                        <td>{task.input.role_name}</td>
                        <td>{truncate(task.input.paragraph_content, 80)}</td>
                        <td>{task.extracted_role_name ?? task.error ?? '-'}</td>
                      </tr>
                    ))}
                    {filteredTasks.length === 0 && (
                      <tr>
                        <td colSpan={9} className="empty-table-cell">没有符合筛选条件的任务</td>
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
                          <td key={header}>{truncate(String(row[header] ?? ''), 42)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <UserRound size={40} />
              <h2>从角色形象提取开始</h2>
              <p>上传包含段落图片链接的 Excel，参考主要人物重绘白底设定立绘。</p>
            </div>
          )}
        </section>

        <aside className="right-panel quality-right">
          <div className="panel-section result-panel">
            <div className="panel-heading">
              <ImageIcon size={18} />
              <span>任务详情</span>
            </div>
            {selectedTask ? (
              <div className="character-detail">
                <div className={`status-pill ${selectedTask.status}`}>第 {selectedTask.row_no} 行 · {statusLabel[selectedTask.status]}</div>
                <strong>{selectedTask.extracted_role_name ?? selectedTask.input.role_name}</strong>
                <p>{selectedTask.input.chapter_name}</p>
                <div className="character-detail-image-grid">
                  <div>
                    <span>段落图片</span>
                    <button className="character-image-panel" onClick={() => setLightboxUrl(selectedTask.input.paragraph_image_url)}>
                      <img src={selectedTask.input.paragraph_image_url} alt={`${selectedTask.input.role_name} 段落图片`} />
                    </button>
                  </div>
                  <div>
                    <span>人物立绘</span>
                    {selectedTask.portrait_files[0] ? (
                      <button className="character-image-panel" onClick={() => setLightboxUrl(absolutePreviewUrl(selectedTask.portrait_files[0].previewUrl))}>
                        <img src={absolutePreviewUrl(selectedTask.portrait_files[0].previewUrl)} alt={selectedTask.portrait_files[0].name} />
                      </button>
                    ) : (
                      <div className="character-image-empty">暂无立绘</div>
                    )}
                  </div>
                </div>
                <div className="character-detail-meta">
                  <span>角色名：{selectedTask.input.role_name}</span>
                  <span>{selectedTask.elapsed_seconds ? `耗时 ${selectedTask.elapsed_seconds}s` : selectedTask.progress_label ?? '-'}</span>
                </div>
                <p>{selectedTask.extracted_description ?? selectedTask.result_text ?? selectedTask.error ?? '等待执行结果'}</p>
                <div className="run-item-actions">
                  <button
                    className="secondary-action"
                    onClick={() => void startSingleTask(selectedTask.id)}
                    disabled={isStarting || !health?.hasCharacterDifyApiKey || selectedTask.status === 'running'}
                  >
                    {isStarting ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                    执行该行
                  </button>
                  <button
                    className="secondary-action"
                    onClick={() => void retryTask(selectedTask.id)}
                    disabled={retryingTaskId === selectedTask.id || selectedTask.status === 'running'}
                  >
                    {retryingTaskId === selectedTask.id ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                    重试该行
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">选择一条任务查看详情。</p>
            )}
          </div>

          <div className="panel-section event-panel">
            <div className="panel-heading">
              <div className="panel-heading-title">
                <RefreshCw size={18} />
                <span>执行日志</span>
                <small>{job?.events.length ?? 0} 条</small>
              </div>
            </div>
            <div className="event-list open">
              {(job?.events ?? []).slice(0, 8).map((event) => (
                <div className={`event-item ${event.type}`} key={event.id}>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <span>{event.message}</span>
                </div>
              ))}
              {selectedTask && taskRuns.length > 0 && (
                <>
                  <div className="panel-heading panel-heading-sub">
                    <span>历史 run</span>
                  </div>
                  {taskRuns.slice(0, 4).map((run) => (
                    <div className={`run-item ${run.status}`} key={run.id}>
                      <div className="run-item-head">
                        <strong>第 {run.attempt_no} 次 · {statusLabel[run.status]}</strong>
                        <time>{formatDateTime(run.created_at)}</time>
                      </div>
                      <div className="run-item-meta">
                        <span>{run.elapsed_seconds ? `${run.elapsed_seconds}s` : '-'}</span>
                      </div>
                      <p className="run-item-title">{run.extracted_role_name ?? selectedTask.input.role_name}</p>
                      {run.portrait_files[0] ? (
                        <button className="run-thumb-button" onClick={() => setLightboxUrl(absolutePreviewUrl(run.portrait_files[0].previewUrl))}>
                          <img src={absolutePreviewUrl(run.portrait_files[0].previewUrl)} alt={run.portrait_files[0].name} />
                        </button>
                      ) : (
                        <div className="run-thumb-empty">暂无图片</div>
                      )}
                      {(run.extracted_description || run.error) && <p>{run.extracted_description ?? run.error}</p>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </aside>
      </section>

      {lightboxUrl && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setLightboxUrl(null)}>
          <div className="lightbox-content" onClick={(event) => event.stopPropagation()}>
            <div className="lightbox-toolbar">
              <span>图片预览</span>
              <div>
                <a href={lightboxUrl} target="_blank" rel="noreferrer">
                  新窗口打开
                </a>
                <button onClick={() => setLightboxUrl(null)}>关闭</button>
              </div>
            </div>
            <img src={lightboxUrl} alt="角色形象预览" />
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <div className={`stat-card ${tone ? `tone-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
