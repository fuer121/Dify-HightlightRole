import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getFile } from './fileStore.js';
import type { ParsedWorkbook } from './types.js';
import {
  __setWorkflowControlsForTest,
  addManualBookTask,
  continueBook,
  cancelBookTasks,
  createBatch,
  deleteBatch,
  deleteTask,
  getTaskRuns,
  hydrateBatchesFromStore,
  listBatchesForBook,
  listBookSummaries,
  listTasksForBook,
  pauseBookTasks,
  pauseTask,
  renameBatch,
  renameBook,
  retryTask,
  startBatch,
  startSelectedTasks
} from './queue.js';
import { closeStoreForTest, getDb, saveBatch } from './store.js';

const workbook: ParsedWorkbook = {
  id: 'workbook-1',
  fileName: 'sample.xlsx',
  createdAt: new Date().toISOString(),
  sheets: [
    {
      name: 'Sheet1',
      headers: ['book_id', 'paragraph_content', 'chapter_sort'],
      previewRows: [],
      rowCount: 3,
      autoMapping: {},
      rows: [
        { __row_no: 2, book_id: '1', paragraph_content: '高光段落', chapter_sort: '2' },
        { __row_no: 3, book_id: '2', paragraph_content: '另一个高光段落', chapter_sort: '3' },
        { __row_no: 4, book_id: '', paragraph_content: '坏数据', chapter_sort: '2' }
      ]
    }
  ]
};

describe('queue', () => {
  afterEach(() => {
    __setWorkflowControlsForTest();
    closeStoreForTest();
  });

  const makeBatch = () =>
    createBatch(workbook, 'Sheet1', {
      book_id: 'book_id',
      paragraph_content: 'paragraph_content',
      chapter_sort: 'chapter_sort'
    });

  const makeBookBatch = () =>
    createBatch(
      {
        ...workbook,
        id: `workbook-book-${Date.now()}-${Math.random()}`,
        fileName: 'book-scope.xlsx',
        sheets: [
          {
            ...workbook.sheets[0],
            rows: [
              { __row_no: 2, book_id: '1', paragraph_content: '第一段', chapter_sort: '1' },
              { __row_no: 3, book_id: '1', paragraph_content: '第二段', chapter_sort: '2' },
              { __row_no: 4, book_id: '1', paragraph_content: '第三段', chapter_sort: '3' }
            ]
          }
        ]
      },
      'Sheet1',
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      }
    );

  it('creates tasks and marks validation failures', () => {
    const batch = makeBatch();

    expect(batch.tasks).toHaveLength(3);
    expect(batch.tasks[0].status).toBe('queued');
    expect(batch.tasks[2].status).toBe('failed');
    expect(batch.tasks[2].error).toContain('字段校验失败');
  });

  it('creates a batch with only the requested leading rows', () => {
    const batch = createBatch(
      workbook,
      'Sheet1',
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      },
      { rowLimit: 2 }
    );

    expect(batch.rowLimit).toBe(2);
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks.map((task) => task.row_no)).toEqual([2, 3]);
  });

  it('pauses a queued task', async () => {
    const batch = makeBatch();
    await pauseTask(batch.id, batch.tasks[0].id);

    expect(batch.tasks[0].status).toBe('paused');
    expect(batch.tasks[0].pause_reason).toBe('task');
  });

  it('stops every known workflow task id when pausing a running dual-workflow task', async () => {
    const stopped: Array<{ taskId: string; workflowId?: string }> = [];
    __setWorkflowControlsForTest(undefined, async (taskId, _batchId, workflowId) => {
      stopped.push({ taskId, workflowId });
      return {};
    });
    const batch = makeBatch();
    const task = batch.tasks[0];
    task.status = 'running';
    task.dify_task_id = 'primary-task';
    task.workflow_results = [
      {
        workflow_id: 'primary',
        workflow_name: '线上工作流',
        status: 'running',
        dify_task_id: 'primary-task',
        result_files: []
      },
      {
        workflow_id: 'compare',
        workflow_name: '对照工作流',
        status: 'running',
        dify_task_id: 'compare-task',
        result_files: []
      }
    ];

    await pauseTask(batch.id, task.id);

    expect(stopped).toEqual([
      { taskId: 'primary-task', workflowId: 'primary' },
      { taskId: 'compare-task', workflowId: 'compare' }
    ]);
    expect(task.stop_requested_at).toBeTruthy();
  });

  it('retries a paused task by queueing it from scratch', async () => {
    __setWorkflowControlsForTest(async () => ({
      workflowRunId: 'run-1',
      taskId: 'task-1',
      outputs: {},
      raw: {}
    }));
    const batch = makeBatch();
    const task = batch.tasks[0];
    await pauseTask(batch.id, task.id);
    task.attempts = 2;
    task.error = 'old error';
    retryTask(batch.id, task.id);

    expect(['queued', 'running']).toContain(task.status);
    expect(task.attempts).toBeLessThan(2);
    expect(task.error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batch.tasks[1].status).toBe('queued');
  });

  it('captures intermediate Dify node outputs during streaming execution', async () => {
    __setWorkflowControlsForTest(async (_task, _batchId, onEvent) => {
      onEvent?.({
        event: 'node_finished',
        task_id: 'task-1',
        data: {
          node_id: '1778480914080',
          title: 'is_valid赋值',
          outputs: { is_valid: 0 }
        }
      });
      onEvent?.({
        event: 'node_finished',
        task_id: 'task-1',
        data: {
          node_id: '1778480918522',
          title: '生成段落描述',
          outputs: { text: '中间生成的段落描述' }
        }
      });
      return {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        outputs: {
          role: ['角色'],
          title: '标题'
        },
        raw: {}
      };
    });

    const batch = makeBatch();
    startBatch(batch.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(batch.tasks[0].is_valid).toBe(0);
    expect(batch.tasks[0].paragraph_description).toBe('中间生成的段落描述');
  });

  it('does not retry validation-failed tasks', () => {
    const batch = makeBatch();

    expect(() => retryTask(batch.id, batch.tasks[2].id)).toThrow('字段校验失败');
  });

  it('deletes a task from the batch', async () => {
    const batch = makeBatch();
    await deleteTask(batch.id, batch.tasks[0].id);

    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0].row_no).toBe(3);
  });

  it('starts only selected queued tasks and leaves other queued tasks untouched', async () => {
    const ranRows: number[] = [];
    __setWorkflowControlsForTest(async (task) => {
      ranRows.push(task.row_no);
      return {
        workflowRunId: `run-${task.row_no}`,
        taskId: `task-${task.row_no}`,
        outputs: { title: `标题 ${task.row_no}` },
        raw: {}
      };
    });

    const batch = makeBatch();
    startSelectedTasks(batch.id, [batch.tasks[0].id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ranRows).toEqual([2]);
    expect(batch.tasks[0].status).toBe('succeeded');
    expect(batch.tasks[1].status).toBe('queued');
    expect(batch.status).toBe('idle');
  });

  it('resets selected completed tasks before scoped generation', async () => {
    __setWorkflowControlsForTest(async () => ({
      workflowRunId: 'run-selected',
      taskId: 'task-selected',
      outputs: { title: '新标题' },
      raw: {}
    }));

    const batch = makeBatch();
    const task = batch.tasks[0];
    task.status = 'succeeded';
    task.attempts = 2;
    task.title = '旧标题';
    task.error = 'old error';
    startSelectedTasks(batch.id, [task.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(task.status).toBe('succeeded');
    expect(task.attempts).toBe(1);
    expect(task.title).toBe('新标题');
    expect(task.error).toBeUndefined();
  });

  it('rejects selected validation-failed tasks', () => {
    const batch = makeBatch();

    expect(() => startSelectedTasks(batch.id, [batch.tasks[2].id])).toThrow('没有可生成');
  });

  it('persists books and restores batches from sqlite', () => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-batch-${Date.now()}-${Math.random()}.sqlite`);
    closeStoreForTest();
    const batch = makeBatch();

    expect(listBookSummaries().map((book) => book.book_id).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    closeStoreForTest();

    const restoredCount = hydrateBatchesFromStore();
    expect(restoredCount).toBeGreaterThan(0);
    const restoredBooks = listBookSummaries();
    expect(restoredBooks.some((book) => book.book_id === batch.tasks[0].input.book_id)).toBe(true);
    delete process.env.BATCH_STORE_PATH;
  });

  it('records task run snapshots after execution', async () => {
    __setWorkflowControlsForTest(async () => ({
      workflowRunId: 'run-recorded',
      taskId: 'dify-task-recorded',
      outputs: { title: '已保存标题' },
      raw: { ok: true }
    }));
    const batch = makeBatch();
    startSelectedTasks(batch.id, [batch.tasks[0].id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = getTaskRuns(batch.tasks[0].id);
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow_run_id).toBe('run-recorded');
    expect(runs[0].status).toBe('succeeded');
  });

  it('marks a dual-workflow task succeeded when one workflow fails but another succeeds', async () => {
    __setWorkflowControlsForTest(async () => [
      {
        workflow_id: 'primary',
        workflow_name: '线上工作流',
        status: 'succeeded',
        workflow_run_id: 'primary-run',
        dify_task_id: 'primary-task',
        result_files: [],
        title: '主流程标题',
        raw_outputs: { title: '主流程标题' }
      },
      {
        workflow_id: 'compare',
        workflow_name: '对照工作流',
        status: 'failed',
        result_files: [],
        error: '对照工作流超时'
      }
    ]);
    const batch = makeBatch();
    startSelectedTasks(batch.id, [batch.tasks[0].id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = getTaskRuns(batch.tasks[0].id);

    expect(batch.tasks[0].status).toBe('succeeded');
    expect(batch.tasks[0].workflow_run_id).toBe('primary-run');
    expect(batch.tasks[0].workflow_results).toHaveLength(2);
    expect(runs[0].workflow_results?.map((result) => result.status)).toEqual(['succeeded', 'failed']);
  });

  it('marks a dual-workflow task failed only when both workflows fail', async () => {
    __setWorkflowControlsForTest(async () => [
      {
        workflow_id: 'primary',
        workflow_name: '线上工作流',
        status: 'failed',
        result_files: [],
        error: '主流程失败'
      },
      {
        workflow_id: 'compare',
        workflow_name: '对照工作流',
        status: 'failed',
        result_files: [],
        error: '对照流程失败'
      }
    ]);
    const batch = makeBatch();
    startSelectedTasks(batch.id, [batch.tasks[0].id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = getTaskRuns(batch.tasks[0].id);

    expect(batch.tasks[0].status).toBe('failed');
    expect(batch.tasks[0].error).toContain('主流程失败');
    expect(batch.tasks[0].error).toContain('对照流程失败');
    expect(runs[0].workflow_results).toHaveLength(2);
  });

  it('registers history-only run files when task runs are listed', () => {
    const batch = makeBatch();
    const task = batch.tasks[0];
    const runOnlyFileId = `run-only-file-${Date.now()}`;
    const runOnlyFile = {
      id: runOnlyFileId,
      taskId: task.id,
      name: 'history-only.png',
      mimeType: 'image/png',
      previewUrl: `/api/files/${runOnlyFileId}`,
      localPath: path.join(os.tmpdir(), `history-only-${runOnlyFileId}.png`),
      sourceKind: 'local' as const
    };

    expect(getFile(runOnlyFileId)).toBeUndefined();

    getDb()
      .prepare(
        `
        INSERT INTO task_runs (
          id, task_id, attempt_no, status, started_at, finished_at, elapsed_seconds,
          workflow_run_id, dify_task_id, result_files_json, result_text, raw_outputs_json,
          error, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        `run-${runOnlyFileId}`,
        task.id,
        1,
        'succeeded',
        null,
        null,
        null,
        'workflow-history-only',
        'dify-history-only',
        JSON.stringify([runOnlyFile]),
        null,
        null,
        null,
        new Date().toISOString()
      );

    const runs = getTaskRuns(task.id);

    expect(runs).toHaveLength(1);
    expect(runs[0].result_files[0]?.id).toBe(runOnlyFileId);
    expect(getFile(runOnlyFileId)).toMatchObject({
      id: runOnlyFileId,
      previewUrl: `/api/files/${runOnlyFileId}`
    });
  });

  it('does not create a temporary task list for manual tasks', () => {
    const task = addManualBookTask({
      book_id: 99,
      chapter_sort: 1,
      paragraph_content: '手动新增段落'
    });

    expect(() => continueBook(99)).toThrow('请先选择一个上传文档任务清单');
    expect(listBatchesForBook(99)).toEqual([]);
    expect(getTaskRuns(task.id)).toHaveLength(0);
  });

  it('continues only book tasks matching the requested filters', async () => {
    const ranRows: number[] = [];
    __setWorkflowControlsForTest(async (task) => {
      ranRows.push(task.row_no);
      return {
        workflowRunId: `run-${task.row_no}`,
        taskId: `task-${task.row_no}`,
        outputs: { title: `标题 ${task.row_no}` },
        raw: {}
      };
    });

    const first = makeBatch();
    const second = createBatch(
      {
        ...workbook,
        id: 'workbook-filtered-continue',
        fileName: 'filtered-continue.xlsx',
        sheets: [
          {
            ...workbook.sheets[0],
            rows: [{ __row_no: 9, book_id: '1', paragraph_content: '第二批待执行段落', chapter_sort: '20' }]
          }
        ]
      },
      'Sheet1',
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      }
    );

    const batch = continueBook(1, { batchId: second.id });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(batch.id).toBe(second.id);
    expect(batch.tasks.map((task) => task.id)).toEqual([second.tasks[0].id]);
    expect(ranRows).toEqual([9]);
    expect(listTasksForBook(1, { batchId: first.id })[0].status).toBe('queued');
  });

  it('supports rerunning succeeded tasks through continueBook filters', async () => {
    let runCount = 0;
    __setWorkflowControlsForTest(async (task) => {
      runCount += 1;
      return {
        workflowRunId: `run-${runCount}`,
        taskId: `task-${runCount}`,
        outputs: { title: `标题 ${task.row_no} - ${runCount}` },
        raw: {}
      };
    });

    const batch = makeBatch();

    continueBook(1, { batchId: batch.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batch.tasks[0].status).toBe('succeeded');
    expect(getTaskRuns(batch.tasks[0].id)).toHaveLength(1);

    continueBook(1, { batchId: batch.id, status: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = getTaskRuns(batch.tasks[0].id);
    expect(batch.tasks[0].status).toBe('succeeded');
    expect(runs).toHaveLength(2);
    expect(runs[0].workflow_run_id).toBe('run-2');
    expect(runs[1].workflow_run_id).toBe('run-1');
  });

  it('pauses only unfinished book tasks in the requested scope and stops running workflow tasks', async () => {
    const stopped: Array<{ taskId: string; workflowId?: string }> = [];
    __setWorkflowControlsForTest(undefined, async (taskId, _batchId, workflowId) => {
      stopped.push({ taskId, workflowId });
      return {};
    });
    const batch = makeBookBatch();
    batch.status = 'running';
    batch.tasks[0].status = 'running';
    batch.tasks[0].dify_task_id = 'primary-running';
    batch.tasks[0].workflow_results = [
      {
        workflow_id: 'primary',
        workflow_name: '线上工作流',
        status: 'running',
        dify_task_id: 'primary-running',
        result_files: []
      },
      {
        workflow_id: 'compare',
        workflow_name: '对照工作流',
        status: 'running',
        dify_task_id: 'compare-running',
        result_files: []
      }
    ];
    saveBatch(batch);

    await pauseBookTasks(1, { batchId: batch.id, rowNoFrom: 2, rowNoTo: 3 });

    expect(stopped).toEqual([
      { taskId: 'primary-running', workflowId: 'primary' },
      { taskId: 'compare-running', workflowId: 'compare' }
    ]);
    expect(batch.tasks[0].stop_requested_at).toBeTruthy();
    expect(batch.tasks[1].status).toBe('paused');
    expect(batch.tasks[1].pause_reason).toBe('batch');
    expect(batch.tasks[2].status).toBe('queued');
  });

  it('cancels only unfinished book tasks in the requested scope while keeping finished tasks', async () => {
    const stopped: Array<{ taskId: string; workflowId?: string }> = [];
    __setWorkflowControlsForTest(undefined, async (taskId, _batchId, workflowId) => {
      stopped.push({ taskId, workflowId });
      return {};
    });
    const batch = makeBookBatch();
    batch.status = 'running';
    batch.tasks[0].status = 'running';
    batch.tasks[0].dify_task_id = 'primary-cancel';
    batch.tasks[0].workflow_results = [
      {
        workflow_id: 'primary',
        workflow_name: '线上工作流',
        status: 'running',
        dify_task_id: 'primary-cancel',
        result_files: []
      },
      {
        workflow_id: 'compare',
        workflow_name: '对照工作流',
        status: 'running',
        dify_task_id: 'compare-cancel',
        result_files: []
      }
    ];
    batch.tasks[1].status = 'succeeded';
    batch.tasks[2].status = 'queued';
    const succeededTaskId = batch.tasks[1].id;
    saveBatch(batch);

    await cancelBookTasks(1, { batchId: batch.id, rowNoFrom: 2, rowNoTo: 4 });

    expect(stopped).toEqual([
      { taskId: 'primary-cancel', workflowId: 'primary' },
      { taskId: 'compare-cancel', workflowId: 'compare' }
    ]);
    expect(batch.tasks.map((task) => task.id)).toEqual([succeededTaskId]);
    expect(batch.tasks).toHaveLength(1);
    expect(batch.tasks[0].status).toBe('succeeded');
    expect(listTasksForBook(1, { batchId: batch.id }).map((task) => task.status)).toEqual(['succeeded']);
  });

  it('requires a concrete task list when pausing or canceling book tasks', async () => {
    makeBookBatch();

    await expect(pauseBookTasks(1)).rejects.toThrow('请先选择一个上传文档任务清单');
    await expect(cancelBookTasks(1)).rejects.toThrow('请先选择一个上传文档任务清单');
  });

  it('requires an uploaded document task list before continuing a book', () => {
    makeBatch();

    expect(() => continueBook(1)).toThrow('请先选择一个上传文档任务清单');
  });

  it('recovers an interrupted running batch that has no running task before continuing', () => {
    __setWorkflowControlsForTest(async () => ({
      workflowRunId: 'run-recovered',
      taskId: 'task-recovered',
      outputs: { title: '恢复后执行' },
      raw: {}
    }));
    const batch = makeBatch();
    batch.status = 'running';
    saveBatch(batch);

    expect(() => continueBook(1, { batchId: batch.id })).not.toThrow();
    expect(batch.status).toBe('running');
  });

  it('keeps a genuinely running task blocked with row-level context', () => {
    const batch = makeBatch();
    batch.status = 'running';
    batch.tasks[0].status = 'running';
    batch.tasks[0].progress_label = '执行节点：HTTP 请求';
    saveBatch(batch);

    expect(() => continueBook(1, { batchId: batch.id })).toThrow('第 2 行');
  });

  it('renames books and persists the display name', () => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-batch-${Date.now()}-${Math.random()}.sqlite`);
    closeStoreForTest();
    makeBatch();

    const renamed = renameBook(1, '废材那又怎样');

    expect(renamed?.name).toBe('废材那又怎样');
    closeStoreForTest();
    expect(listBookSummaries().find((book) => book.book_id === 1)?.name).toBe('废材那又怎样');
    delete process.env.BATCH_STORE_PATH;
  });

  it('renames batches and persists the display name in book batch lists', () => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-batch-${Date.now()}-${Math.random()}.sqlite`);
    closeStoreForTest();
    const batch = makeBatch();

    renameBatch(batch.id, '第一批高光任务');

    expect(listBatchesForBook(1)[0].file_name).toBe('第一批高光任务');
    closeStoreForTest();
    expect(listBatchesForBook(1)[0].file_name).toBe('第一批高光任务');
    delete process.env.BATCH_STORE_PATH;
  });

  it('lists batches for a single book with task statistics', () => {
    const first = makeBatch();
    const second = createBatch(
      {
        ...workbook,
        id: 'workbook-2',
        fileName: 'second.xlsx',
        sheets: [
          {
            ...workbook.sheets[0],
            rows: [{ __row_no: 2, book_id: '1', paragraph_content: '第二批段落', chapter_sort: '8' }]
          }
        ]
      },
      'Sheet1',
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      }
    );

    const summaries = listBatchesForBook(1);

    expect(summaries.map((batch) => batch.id)).toEqual([second.id, first.id]);
    expect(summaries[0].task_count).toBe(1);
    expect(summaries[1].task_count).toBe(1);
  });

  it('deletes a batch and removes its tasks from book views', async () => {
    const first = makeBatch();
    const second = createBatch(
      {
        ...workbook,
        id: 'workbook-delete',
        fileName: 'delete-target.xlsx',
        sheets: [
          {
            ...workbook.sheets[0],
            rows: [{ __row_no: 2, book_id: '1', paragraph_content: '待删除批次段落', chapter_sort: '9' }]
          }
        ]
      },
      'Sheet1',
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      }
    );

    await deleteBatch(second.id);

    expect(listBatchesForBook(1).map((batch) => batch.id)).toEqual([first.id]);
    expect(listTasksForBook(1, { batchId: second.id })).toEqual([]);
    expect(listTasksForBook(1).map((task) => task.id)).not.toContain(second.tasks[0].id);
  });

  it('filters book tasks by batch, chapter range, row range, image presence, and value status', () => {
    const batch = makeBatch();
    batch.tasks[0].is_valid = 1;
    batch.tasks[0].result_files = [
      {
        id: 'file-1',
        taskId: batch.tasks[0].id,
        name: 'result.png',
        mimeType: 'image/png',
        previewUrl: '/api/files/file-1',
        sourceKind: 'local'
      }
    ];
    batch.tasks[1].is_valid = 0;
    saveBatch(batch);

    const valuableWithImage = listTasksForBook(1, {
      batchId: batch.id,
      chapterSortFrom: 2,
      chapterSortTo: 2,
      hasImage: 'yes',
      valueStatus: 'valuable'
    });
    const notValuable = listTasksForBook(2, { hasImage: 'no', valueStatus: 'not_valuable' });
    const rowRange = listTasksForBook(1, { rowNoFrom: 2, rowNoTo: 2 });

    expect(valuableWithImage.map((task) => task.id)).toEqual([batch.tasks[0].id]);
    expect(rowRange.map((task) => task.id)).toEqual([batch.tasks[0].id]);
    expect(notValuable.map((task) => task.id)).toEqual([batch.tasks[1].id]);
  });
});
