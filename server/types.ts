export type RequiredInputKey = 'book_id' | 'paragraph_content' | 'chapter_sort';

export type ColumnMapping = Record<RequiredInputKey, string>;
export type CharacterInputKey =
  | 'novel_name'
  | 'chapter_sort'
  | 'chapter_name'
  | 'paragraph_content'
  | 'paragraph_image_url'
  | 'role_name';

export type CharacterColumnMapping = Record<CharacterInputKey, string>;

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';
export type RoleAssetStatus = 'draft' | 'active' | 'disabled';
export type RoleAssetSource = 'manual' | 'character_task' | 'import';
export type ManagedWorkflowId = 'primary' | 'compare';
export type WorkflowGroupStatus = 'active' | 'disabled';

export interface ManagedWorkflowConfig {
  id: ManagedWorkflowId;
  group_id?: string;
  name: string;
  api_key?: string;
  console_url?: string;
  note?: string;
  created_at: string;
  updated_at: string;
}

export interface ManagedWorkflowGroup {
  id: string;
  name: string;
  status: WorkflowGroupStatus;
  is_default: boolean;
  note?: string;
  workflows: ManagedWorkflowConfig[];
  created_at: string;
  updated_at: string;
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
  previewRows: Record<string, unknown>[];
  rowCount: number;
  autoMapping: Partial<ColumnMapping>;
  characterAutoMapping?: Partial<CharacterColumnMapping>;
}

export interface ParsedWorkbook {
  id: string;
  fileName: string;
  sheets: ParsedSheet[];
  createdAt: string;
}

export interface ResultFile {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  size?: number;
  previewUrl: string;
  remoteUrl?: string;
  remoteUrls?: string[];
  localPath?: string;
  sourceKind: 'remote' | 'base64' | 'local';
}

export interface WorkflowResult {
  workflow_group_id?: string;
  workflow_group_name?: string;
  workflow_id: string;
  workflow_name: string;
  status: 'running' | 'succeeded' | 'failed';
  workflow_run_id?: string;
  dify_task_id?: string;
  elapsed_seconds?: number;
  is_valid?: unknown;
  paragraph_description?: string;
  role?: string[];
  title?: string;
  result_files: ResultFile[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

export interface BatchTask {
  id: string;
  batch_id?: string;
  source_kind?: string;
  workflow_group_id?: string;
  workflow_group_name?: string;
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
  workflow_results?: WorkflowResult[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
}

export interface BookSummary {
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

export interface BookDetail extends BookSummary {
  latest_batch_id?: string;
}

export interface BookBatchSummary {
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

export interface TaskRunRecord {
  id: string;
  task_id: string;
  attempt_no: number;
  status: TaskStatus;
  workflow_group_id?: string;
  workflow_group_name?: string;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds?: number;
  workflow_run_id?: string;
  dify_task_id?: string;
  is_valid?: unknown;
  result_files: ResultFile[];
  workflow_results?: WorkflowResult[];
  result_text?: string;
  raw_outputs?: unknown;
  error?: string;
  created_at: string;
}

export interface Batch {
  id: string;
  workbookId: string;
  sheetName: string;
  fileName: string;
  mapping: ColumnMapping;
  rowLimit?: number;
  status: 'idle' | 'running' | 'paused' | 'completed';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pauseRequested: boolean;
  export?: LarkExportResult;
  tasks: BatchTask[];
  events: BatchLogEvent[];
}

export interface BatchLogEvent {
  id: string;
  type: 'info' | 'error' | 'task' | 'export';
  message: string;
  createdAt: string;
  taskId?: string;
}

export interface DifyRunResult {
  workflowRunId?: string;
  taskId?: string;
  outputs: Record<string, unknown>;
  raw: unknown;
}

export interface LarkExportResult {
  baseToken?: string;
  baseUrl?: string;
  tableId?: string;
  tableName: string;
  createdAt: string;
  recordsCreated: number;
  attachmentsUploaded: number;
  attachmentsFailed?: number;
}

export interface CharacterTask {
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

export interface CharacterTaskRunRecord {
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

export interface CharacterJobEvent {
  id: string;
  type: 'info' | 'error' | 'task';
  message: string;
  createdAt: string;
  taskId?: string;
}

export interface CharacterJob {
  id: string;
  workbookId: string;
  sheetName: string;
  fileName: string;
  mapping: CharacterColumnMapping;
  promptText: string;
  status: 'idle' | 'running' | 'paused' | 'completed';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  tasks: CharacterTask[];
  events: CharacterJobEvent[];
}

export interface RoleAssetProfile {
  id: string;
  role_asset_id: string;
  chapter_sort: number;
  age?: string;
  gender?: string;
  appearance?: string;
  created_at: string;
  updated_at: string;
}

export interface RoleAsset {
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
  deleted_at?: string;
  profiles?: RoleAssetProfile[];
}

export interface RoleContextRequest {
  book_id: number;
  role_title: string;
  describe: string;
  chapter_sort: number;
}

export interface RoleContextResponse {
  role_url: string;
  role_list: string[];
  prompt: string;
  highlight_content: string;
  role_url_describe: string;
  role_have_pic: string;
  role_info: string;
}

export interface CharacterJobSummary {
  id: string;
  file_name: string;
  sheet_name: string;
  status: CharacterJob['status'];
  created_at: string;
  updated_at: string;
  task_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  paused_count: number;
}
