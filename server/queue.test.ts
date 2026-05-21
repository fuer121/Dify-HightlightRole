import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedWorkbook } from './types.js';
import { __setWorkflowControlsForTest, createBatch, deleteTask, pauseTask, retryTask } from './queue.js';

const workbook: ParsedWorkbook = {
  id: 'workbook-1',
  fileName: 'sample.xlsx',
  createdAt: new Date().toISOString(),
  sheets: [
    {
      name: 'Sheet1',
      headers: ['book_id', 'paragraph_content', 'chapter_sort'],
      previewRows: [],
      rowCount: 2,
      autoMapping: {},
      rows: [
        { __row_no: 2, book_id: '1', paragraph_content: '高光段落', chapter_sort: '2' },
        { __row_no: 3, book_id: '', paragraph_content: '坏数据', chapter_sort: '2' }
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

    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0].status).toBe('queued');
    expect(batch.tasks[1].status).toBe('failed');
    expect(batch.tasks[1].error).toContain('字段校验失败');
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

  it('does not retry validation-failed tasks', () => {
    const batch = makeBatch();

    expect(() => retryTask(batch.id, batch.tasks[1].id)).toThrow('字段校验失败');
  });

  it('deletes a task from the batch', async () => {
    const batch = makeBatch();
    await deleteTask(batch.id, batch.tasks[0].id);

    expect(batch.tasks).toHaveLength(1);
    expect(batch.tasks[0].row_no).toBe(3);
  });
});
