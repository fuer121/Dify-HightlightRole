import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedWorkbook } from './types.js';
import {
  __setLarkCliRunnerForTest,
  exportCharacterJobToLark,
  type LarkCliRunner
} from './lark.js';
import {
  __setCharacterWorkflowControlsForTest,
  createCharacterJob,
  getCharacterJob,
  getCharacterTaskRuns,
  listCharacterJobs,
  pauseCharacterJob,
  retryCharacterTask,
  startCharacterJob,
  updateCharacterJobPrompt
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

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('character jobs', () => {
  beforeEach(() => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-character-${Date.now()}-${Math.random()}.sqlite`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
    );
  });

  afterEach(() => {
    __setCharacterWorkflowControlsForTest();
    closeStoreForTest();
    delete process.env.BATCH_STORE_PATH;
    delete process.env.CHARACTER_DIFY_AUTO_RETRIES;
    delete process.env.CHARACTER_DIFY_RETRY_DELAY_MS;
    delete process.env.CHARACTER_DIFY_TASK_DELAY_MS;
    delete process.env.CHARACTER_DIFY_MAX_TASKS_PER_RUN;
    delete process.env.LARK_CLI_RETRIES;
    delete process.env.LARK_CLI_RETRY_DELAY_MS;
    __setLarkCliRunnerForTest();
    vi.unstubAllGlobals();
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
    await waitFor(() => getCharacterJob(job.id)?.status === 'completed');

    const finished = getCharacterJob(job.id);
    expect(finished?.tasks[0]).toMatchObject({
      status: 'succeeded',
      extracted_role_name: '云筝-提取',
      extracted_description: '云筝 立绘描述'
    });
    expect(finished?.tasks[0].portrait_files).toHaveLength(1);
    expect(getCharacterTaskRuns(finished!.tasks[0].id)).toHaveLength(1);

    retryCharacterTask(job.id, finished!.tasks[0].id);
    await waitFor(() => getCharacterTaskRuns(finished!.tasks[0].id).length === 2);

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
    await waitFor(() => getCharacterJob(job.id)?.tasks[1]?.status === 'succeeded');

    const scoped = getCharacterJob(job.id)!;
    expect(processedRows).toEqual([3]);
    expect(scoped.tasks.map((task) => task.status)).toEqual(['queued', 'succeeded']);
    expect(scoped.events[0]?.message).toContain('本次筛选范围已执行完成');
  });

  it('exports only requested character tasks to Lark with portrait and source image attachments', async () => {
    const larkCalls: Array<{ args: string[]; cwd?: string }> = [];
    const createdRecordPayloads: unknown[] = [];
    const runner: LarkCliRunner = async (args, options) => {
      larkCalls.push({ args, cwd: options?.cwd });
      if (args.includes('+base-create')) {
        const json = { data: { app_token: 'base-token', url: 'https://feishu.example/base/base-token' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { data: { table_id: 'tblCharacter' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const jsonArg = args[args.indexOf('--json') + 1];
        const payloadPath = path.join(options?.cwd ?? process.cwd(), jsonArg.replace(/^@\.?\//, ''));
        const payload = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(payloadPath, 'utf8')));
        createdRecordPayloads.push(payload);
        const json = { data: { record_id_list: ['recOnlyRequested'] } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      return { stdout: '{}', stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);

    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `export-run-${task.row_no}`,
      taskId: `export-task-${task.row_no}`,
      outputs: {
        character_name: `${task.input.role_name}-提取`,
        description: `${task.input.role_name} 立绘描述`,
        character_image: `https://cdn.example.com/portrait-${task.row_no}.png`
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

    startCharacterJob(job.id, [job.tasks[0].id]);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    const result = await exportCharacterJobToLark(getCharacterJob(job.id)!, [job.tasks[0].id]);

    expect(result.recordsCreated).toBe(1);
    expect(createdRecordPayloads).toHaveLength(1);
    const tableCreateCall = larkCalls.find((call) => call.args.includes('+table-create'));
    const tableFields = JSON.parse(tableCreateCall!.args[tableCreateCall!.args.indexOf('--fields') + 1]);
    expect(tableFields.map((field: { name: string }) => field.name)).toEqual(expect.arrayContaining(['原段落图片', '生成立绘']));
    expect(createdRecordPayloads[0]).toMatchObject({
      fields: expect.arrayContaining(['行号', '小说名', '角色名', '角色描述']),
      rows: [
        expect.arrayContaining([
          2,
          'succeeded',
          '第一瞳术师',
          1,
          '第1章 异世重生',
          '云筝-提取',
          '段落一',
          '云筝 立绘描述',
          'export-run-2',
          'export-task-2'
        ])
      ]
    });
    expect(larkCalls.filter((call) => call.args.includes('+record-upload-attachment')).map((call) => call.args[call.args.indexOf('--field-id') + 1])).toEqual([
      '生成立绘',
      '原段落图片'
    ]);
  });

  it('retries transient lark-cli network timeouts during export', async () => {
    process.env.LARK_CLI_RETRIES = '1';
    process.env.LARK_CLI_RETRY_DELAY_MS = '0';
    let uploadAttempts = 0;
    const runner: LarkCliRunner = async (args) => {
      if (args.includes('+base-create')) {
        const json = { data: { app_token: 'base-token', url: 'https://feishu.example/base/base-token' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { data: { table_id: 'tblCharacter' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const json = { data: { record_id_list: ['recOnlyRequested'] } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-upload-attachment')) {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw new Error('lark-cli 失败（exit 4）：{"error":{"type":"network","subtype":"timeout","message":"TLS handshake timeout"}}');
        }
      }
      return { stdout: '{}', stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);

    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `retry-export-run-${task.row_no}`,
      taskId: `retry-export-task-${task.row_no}`,
      outputs: {
        character_name: task.input.role_name,
        description: `${task.input.role_name} 立绘描述`,
        character_image: `https://cdn.example.com/retry-portrait-${task.row_no}.png`
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

    startCharacterJob(job.id, [job.tasks[0].id]);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    const result = await exportCharacterJobToLark(getCharacterJob(job.id)!, [job.tasks[0].id]);

    expect(result.attachmentsUploaded).toBe(2);
    expect(uploadAttempts).toBe(3);
  });

  it('keeps exported records when attachment uploads keep timing out', async () => {
    process.env.LARK_CLI_RETRIES = '1';
    process.env.LARK_CLI_RETRY_DELAY_MS = '0';
    const runner: LarkCliRunner = async (args) => {
      if (args.includes('+base-create')) {
        const json = { data: { app_token: 'base-token', url: 'https://feishu.example/base/base-token' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { data: { table_id: 'tblCharacter' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const json = { data: { record_id_list: ['recOnlyRequested'] } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-upload-attachment')) {
        throw new Error('lark-cli 失败（exit 4）：{"error":{"type":"network","subtype":"timeout","message":"TLS handshake timeout"}}');
      }
      return { stdout: '{}', stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);

    __setCharacterWorkflowControlsForTest(async (task) => ({
      workflowRunId: `partial-export-run-${task.row_no}`,
      taskId: `partial-export-task-${task.row_no}`,
      outputs: {
        character_name: task.input.role_name,
        description: `${task.input.role_name} 立绘描述`,
        character_image: `https://cdn.example.com/partial-portrait-${task.row_no}.png`
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

    startCharacterJob(job.id, [job.tasks[0].id]);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    const result = await exportCharacterJobToLark(getCharacterJob(job.id)!, [job.tasks[0].id]);

    expect(result.recordsCreated).toBe(1);
    expect(result.attachmentsUploaded).toBe(0);
    expect(result.attachmentsFailed).toBe(2);
  });

  it('exports the extracted portrait role name instead of the original multi-role image field', async () => {
    const larkCalls: Array<{ args: string[]; cwd?: string }> = [];
    const createdRecordPayloads: unknown[] = [];
    const runner: LarkCliRunner = async (args, options) => {
      larkCalls.push({ args, cwd: options?.cwd });
      if (args.includes('+base-create')) {
        const json = { data: { app_token: 'base-token', url: 'https://feishu.example/base/base-token' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { data: { table_id: 'tblCharacter' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const jsonArg = args[args.indexOf('--json') + 1];
        const payloadPath = path.join(options?.cwd ?? process.cwd(), jsonArg.replace(/^@\.?\//, ''));
        const payload = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(payloadPath, 'utf8')));
        createdRecordPayloads.push(payload);
        const json = { data: { record_id_list: ['recExtractedRole'] } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      return { stdout: '{}', stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);

    __setCharacterWorkflowControlsForTest(async () => ({
      workflowRunId: 'export-run-extracted-role',
      taskId: 'export-task-extracted-role',
      outputs: {
        character_name: '云筝',
        description: '云筝单人立绘',
        character_image: 'https://cdn.example.com/yunzheng.png'
      },
      raw: {}
    }));

    const multiRoleWorkbook: ParsedWorkbook = {
      ...workbook,
      id: 'character-workbook-multi-role',
      sheets: [
        {
          ...workbook.sheets[0],
          rows: [
            {
              ...workbook.sheets[0].rows[0],
              roles: '云筝,容烁'
            }
          ]
        }
      ]
    };
    const job = createCharacterJob(
      multiRoleWorkbook,
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

    startCharacterJob(job.id, [job.tasks[0].id]);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    await exportCharacterJobToLark(getCharacterJob(job.id)!, [job.tasks[0].id]);

    expect(createdRecordPayloads[0]).toMatchObject({
      fields: expect.arrayContaining(['角色名']),
      rows: [expect.arrayContaining(['云筝'])]
    });
    expect(JSON.stringify(createdRecordPayloads[0])).not.toContain('云筝,容烁');
  });

  it('uses updated character prompt for subsequent task runs', async () => {
    let receivedPrompt = '';
    __setCharacterWorkflowControlsForTest(async (_task, promptText) => {
      receivedPrompt = promptText;
      return {
        workflowRunId: 'prompt-run',
        taskId: 'prompt-task',
        outputs: {
          character_image: 'https://cdn.example.com/prompt.png'
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
      '旧 Prompt'
    );

    const updated = updateCharacterJobPrompt(job.id, '新版重绘设定图 Prompt');
    expect(updated.promptText).toBe('新版重绘设定图 Prompt');

    (startCharacterJob as (jobId: string, taskIds?: string[]) => unknown)(job.id, [job.tasks[0].id]);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    expect(receivedPrompt).toBe('新版重绘设定图 Prompt');
  });

  it('does not drain unrelated queued tasks when retrying one character task', async () => {
    const processedRows: number[] = [];
    __setCharacterWorkflowControlsForTest(async (task) => {
      processedRows.push(task.row_no);
      return {
        workflowRunId: `single-retry-run-${task.row_no}`,
        taskId: `single-retry-task-${task.row_no}`,
        outputs: {
          character_image: `https://cdn.example.com/single-retry-${task.row_no}.png`
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
    job.tasks[0].status = 'failed';
    job.tasks[0].error = '立绘生成失败';

    retryCharacterTask(job.id, job.tasks[0].id);
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    expect(processedRows).toEqual([2]);
    expect(getCharacterJob(job.id)!.tasks.map((task) => task.status)).toEqual(['succeeded', 'queued']);
  });

  it('pauses the character job without starting the next queued task', async () => {
    const processedRows: number[] = [];
    let releaseFirstTask!: () => void;
    const firstTaskStarted = new Promise<void>((resolveStarted) => {
      __setCharacterWorkflowControlsForTest(async (task) => {
        processedRows.push(task.row_no);
        if (task.row_no === 2) {
          resolveStarted();
          await new Promise<void>((resolveRelease) => {
            releaseFirstTask = resolveRelease;
          });
        }
        return {
          workflowRunId: `pause-run-${task.row_no}`,
          taskId: `pause-task-${task.row_no}`,
          outputs: {
            character_image: `https://cdn.example.com/pause-${task.row_no}.png`
          },
          raw: {}
        };
      });
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
    await firstTaskStarted;
    pauseCharacterJob(job.id);
    releaseFirstTask();
    await waitFor(() => getCharacterJob(job.id)?.tasks[0]?.status === 'succeeded');

    const paused = getCharacterJob(job.id)!;
    expect(processedRows).toEqual([2]);
    expect(paused.status).toBe('paused');
    expect(paused.tasks.map((task) => task.status)).toEqual(['succeeded', 'paused']);
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
    await waitFor(() => getCharacterJob(job.id)?.status === 'completed');

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
    await waitFor(() => getCharacterJob(job.id)?.status === 'completed');

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
    await waitFor(() => getCharacterJob(job.id)?.status === 'completed');

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
    await waitFor(() => getCharacterJob(job.id)?.status === 'paused');

    const sampled = getCharacterJob(job.id)!;
    expect(sampled.status).toBe('paused');
    expect(sampled.tasks.map((task) => task.status)).toEqual(['succeeded', 'queued']);
    expect(sampled.events[0]?.message).toContain('本轮样本上限');
  });
});
