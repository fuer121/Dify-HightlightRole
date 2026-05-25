export type RequiredInputKey = 'book_id' | 'paragraph_content' | 'chapter_sort';

export type ColumnMapping = Record<RequiredInputKey, string>;

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
  previewRows: Record<string, unknown>[];
  rowCount: number;
  autoMapping: Partial<ColumnMapping>;
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

export interface BatchTask {
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
}
