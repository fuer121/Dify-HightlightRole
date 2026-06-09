import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedWorkbook } from './types.js';
import {
  __setCharacterWorkflowControlsForTest,
  createCharacterJob,
  getCharacterJob,
  getCharacterTaskRuns,
  listCharacterJobs,
  retryCharacterTask,
  startCharacterJob
} from './characters.js';
import { closeStoreForTest } from './store.js';

const workbook: ParsedWorkbook = {
  id: 'character-workbook-1',
  fileName: 'characters.xlsx',
  createdAt: new Date().toISOString(),
  sheets: [
    {
      name: '执行结果7',
      headers: ['章节序号', 'book_title', 'chapter_title', 'paragraph_content', 'hightlight_image_url', 'roles'],
      previewRows: [],
      rowCount: 2,
      autoMapping: {},
      rows: [
        {
          __row_no: 2,
          章节序号: '1',
          book_title: '第一瞳术师',
          chapter_title: '第1章 异世重生',
          paragraph_content: '段落一',
          hightlight_image_url: 'https://cdn.example.com/a.png',
          roles: '云筝'
        },
        {
          __row_no: 3,
          章节序号: '2',
          book_title: '第一瞳术师',
          chapter_title: '第2章',
          paragraph_content: '段落二',
          hightlight_image_url: 'https://cdn.example.com/b.png',
          roles: '容烁'
        }
      ]
    }
  ]
};

describe('character jobs', () => {
  beforeEach(() => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-character-${Date.now()}-${Math.random()}.sqlite`);
  });

  afterEach(() => {
    __setCharacterWorkflowControlsForTest();
    closeStoreForTest();
    delete process.env.BATCH_STORE_PATH;
    delete process.env.CHARACTER_DIFY_AUTO_RETRIES;
    delete process.env.CHARACTER_DIFY_RETRY_DELAY_MS;
    delete process.env.CHARACTER_DIFY_TASK_DELAY_MS;
    delete process.env.CHARACTER_DIFY_MAX_TASKS_PER_RUN;
  });

  it('creates persisted character jobs from workbook rows', () => {
    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    expect(job.tasks).toHaveLength(2);
    expect(listCharacterJobs()[0]?.id).toBe(job.id);
    expect(getCharacterJob(job.id)?.tasks[0]?.input.paragraph_image_url).toBe('https://cdn.example.com/a.png');
  });

  it('runs character jobs, persists outputs, and keeps run history on retry', async () => {
    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `run-${task.row_no}`,
      taskId: `task-${task.row_no}`,
      outputs: {
        role_name: `${task.input.role_name}-提取`,
        description: `${task.input.role_name} 立绘描述`,
        character_image: `https://cdn.example.com/${task.row_no}.png`
      },
      raw: {}
    }));

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    startCharacterJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const finished = getCharacterJob(job.id);
    expect(finished?.tasks[0]).toMatchObject({
      status: 'succeeded',
      extracted_role_name: '云筝-提取',
      extracted_description: '云筝 立绘描述'
    });
    expect(finished?.tasks[0].portrait_files).toHaveLength(1);
    expect(getCharacterTaskRuns(finished!.tasks[0].id)).toHaveLength(1);

    retryCharacterTask(job.id, finished!.tasks[0].id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCharacterTaskRuns(finished!.tasks[0].id)).toHaveLength(2);
  });

  it('starts only the requested character task ids', async () => {
    const processedRows: number[] = [];
    __setCharacterWorkflowControlsForTest(async (task) => {
      processedRows.push(task.row_no);
      return {
        workflowRunId: `scoped-run-${task.row_no}`,
        taskId: `scoped-task-${task.row_no}`,
        outputs: {
          character_image: `https://cdn.example.com/scoped-${task.row_no}.png`
        },
        raw: {}
      };
    });

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    const targetTaskId = job.tasks[1].id;
    (startCharacterJob as (jobId: string, taskIds?: string[]) => unknown)(job.id, [targetTaskId]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scoped = getCharacterJob(job.id)!;
    expect(processedRows).toEqual([3]);
    expect(scoped.tasks.map((task) => task.status)).toEqual(['queued', 'succeeded']);
  });

  it('keeps Dify outputs for failed image parsing attempts', async () => {
    __setCharacterWorkflowControlsForTest(async () => ({
      workflowRunId: 'run-without-image',
      taskId: 'task-without-image',
      outputs: {
        character_name: '云筝',
        description: '只返回了角色描述'
      },
      raw: {}
    }));

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    startCharacterJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failedTask = getCharacterJob(job.id)!.tasks[0];
    const [run] = getCharacterTaskRuns(failedTask.id);

    expect(failedTask).toMatchObject({
      status: 'failed',
      workflow_run_id: 'run-without-image',
      dify_task_id: 'task-without-image',
      raw_outputs: {
        character_name: '云筝',
        description: '只返回了角色描述'
      },
      error: '未返回立绘图片'
    });
    expect(run).toMatchObject({
      status: 'failed',
      workflow_run_id: 'run-without-image',
      dify_task_id: 'task-without-image',
      raw_outputs: {
        character_name: '云筝',
        description: '只返回了角色描述'
      }
    });
  });

  it('resumes running character jobs after worker state is lost', async () => {
    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `resumed-run-${task.row_no}`,
      taskId: `resumed-task-${task.row_no}`,
      outputs: {
        character_image: `https://cdn.example.com/resumed-${task.row_no}.png`
      },
      raw: {}
    }));

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );
    job.status = 'running';
    job.tasks[0].status = 'running';

    startCharacterJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumed = getCharacterJob(job.id)!;
    expect(resumed.tasks[0]).toMatchObject({
      status: 'succeeded',
      workflow_run_id: 'resumed-run-2'
    });
  });

  it('auto retries retryable character workflow errors', async () => {
    process.env.CHARACTER_DIFY_AUTO_RETRIES = '2';
    process.env.CHARACTER_DIFY_RETRY_DELAY_MS = '0';
    let calls = 0;
    __setCharacterWorkflowControlsForTest(async (task) => {
      calls += 1;
      if (calls === 1) throw new Error('角色形象提取请求失败：fetch failed (ECONNRESET: socket hang up)');
      return {
        workflowRunId: `retry-run-${task.row_no}`,
        taskId: `retry-task-${task.row_no}`,
        outputs: {
          character_image: `https://cdn.example.com/retry-${task.row_no}.png`
        },
        raw: {}
      };
    });

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    startCharacterJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(3);
    expect(getCharacterJob(job.id)!.tasks[0]).toMatchObject({
      status: 'succeeded',
      workflow_run_id: 'retry-run-2'
    });
    expect(getCharacterJob(job.id)!.events.some((event) => event.message.includes('自动重试'))).toBe(true);
  });

  it('pauses after the configured per-run sample size', async () => {
    process.env.CHARACTER_DIFY_MAX_TASKS_PER_RUN = '1';
    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `sample-run-${task.row_no}`,
      taskId: `sample-task-${task.row_no}`,
      outputs: {
        character_image: `https://cdn.example.com/sample-${task.row_no}.png`
      },
      raw: {}
    }));

    const job = createCharacterJob(
      workbook,
      '执行结果7',
      {
        novel_name: 'book_title',
        chapter_sort: '章节序号',
        chapter_name: 'chapter_title',
        paragraph_content: 'paragraph_content',
        paragraph_image_url: 'hightlight_image_url',
        role_name: 'roles'
      },
      '默认 prompt'
    );

    startCharacterJob(job.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sampled = getCharacterJob(job.id)!;
    expect(sampled.status).toBe('paused');
    expect(sampled.tasks.map((task) => task.status)).toEqual(['succeeded', 'queued']);
    expect(sampled.events[0]?.message).toContain('本轮样本上限');
  });
});
