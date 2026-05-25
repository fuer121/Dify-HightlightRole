import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedWorkbook } from './types.js';
import { __setWorkflowControlsForTest, createBatch, deleteTask, pauseTask, retryTask, startBatch, startSelectedTasks } from './queue.js';

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
  });

  const makeBatch = () =>
    createBatch(workbook, 'Sheet1', {
      book_id: 'book_id',
      paragraph_content: 'paragraph_content',
      chapter_sort: 'chapter_sort'
    });

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
});
