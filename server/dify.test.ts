import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchTask } from './types.js';
import { __testables, applyDifyResult } from './dify.js';

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('dify helpers', () => {
  afterEach(() => {
    delete process.env.DIFY_API_BASE;
  });

  it('extracts outputs from blocking payload shape', () => {
    expect(
      __testables.extractOutputs({
        data: {
          workflow_run_id: 'run-1',
          outputs: {
            title: '标题',
            role: ['陈平安']
          }
        }
      })
    ).toEqual({
      title: '标题',
      role: ['陈平安']
    });
  });

  it('parses SSE workflow_finished blocks', () => {
    const sse = 'event: workflow_finished\ndata: {"event":"workflow_finished","data":{"outputs":{"title":"完成"}}}\n\n';
    const blocks = __testables.parseSseBlocks(sse);
    expect(blocks.complete).toHaveLength(1);
    expect(__testables.parseSseJson(blocks.complete[0])).toMatchObject({
      event: 'workflow_finished',
      data: {
        outputs: {
          title: '完成'
        }
      }
    });
  });

  it('extracts task id and progress hints from streaming payloads', () => {
    const payload = {
      event: 'node_started',
      task_id: 'task-123',
      data: {
        title: 'HTTP 请求'
      }
    };

    expect(__testables.extractTaskId(payload)).toBe('task-123');
    expect(__testables.extractProgress(payload)).toEqual({
      percent: 25,
      label: '执行节点：HTTP 请求'
    });
  });

  it('extracts configured intermediate outputs from node_finished payloads', () => {
    expect(
      __testables.extractIntermediateOutputs({
        event: 'node_finished',
        data: {
          node_id: '1778480914080',
          title: 'is_valid赋值',
          outputs: {
            is_valid: '1'
          }
        }
      })
    ).toEqual({ is_valid: '1' });

    expect(
      __testables.extractIntermediateOutputs({
        event: 'node_finished',
        data: {
          id: '1778480918522',
          title: '生成段落描述',
          outputs: {
            text: '一段可用于生成角色图的画面描述'
          }
        }
      })
    ).toEqual({ paragraph_description: '一段可用于生成角色图的画面描述' });
  });

  it('treats busy upstream model errors as retryable', () => {
    expect(
      __testables.isRetryableDifyErrorMessage(
        '[models] Error: API request failed with status code 503: {"error":{"message":"Service is too busy.","type":"service_unavailable_error"}}'
      )
    ).toBe(true);
    expect(__testables.isRetryableDifyErrorMessage('字段校验失败：book_id 为空')).toBe(false);
  });

  it('normalizes relative Dify file URLs into preview files', async () => {
    process.env.DIFY_API_BASE = 'http://dify.qmniu.com/v1';
    const files = await __testables.normalizeFileValue('task-1', {
      url: '/files/result.png',
      name: 'result.png',
      mime_type: 'image/png'
    });

    expect(files).toHaveLength(1);
    expect(files[0].remoteUrls).toContain('http://dify.qmniu.com/files/result.png');
    expect(files[0].remoteUrls).toContain('http://dify.qmniu.com/v1/files/result.png');
  });

  it('caches remote result files locally when applying workflow outputs', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length)
      });
      res.end(png);
    });
    const port = await listen(server);
    const task: BatchTask = {
      id: 'task-cache',
      row_no: 2,
      input: {
        book_id: 1,
        paragraph_content: '段落',
        chapter_sort: 1
      },
      status: 'running',
      attempts: 1,
      result_files: []
    };

    try {
      await applyDifyResult(task, {
        workflowRunId: 'run-cache',
        taskId: 'dify-cache',
        outputs: {
          result: [
            {
              url: `http://127.0.0.1:${port}/image.png`,
              filename: 'image.png',
              mime_type: 'image/png'
            }
          ]
        },
        raw: {}
      });
    } finally {
      server.close();
    }

    expect(task.result_files).toHaveLength(1);
    expect(task.result_files[0].localPath).toBeTruthy();
    expect(task.result_files[0].size).toBe(png.length);
  });

  it('accepts alternate image output field names', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length)
      });
      res.end(png);
    });
    const port = await listen(server);
    const task: BatchTask = {
      id: 'task-alt-image',
      row_no: 2,
      input: {
        book_id: 1,
        paragraph_content: '段落',
        chapter_sort: 1
      },
      status: 'running',
      attempts: 1,
      result_files: []
    };

    try {
      await applyDifyResult(task, {
        workflowRunId: 'run-alt-image',
        taskId: 'dify-alt-image',
        outputs: {
          image_url: `http://127.0.0.1:${port}/alternate.png`
        },
        raw: {}
      });
    } finally {
      server.close();
    }

    expect(task.result_files).toHaveLength(1);
    expect(task.result_files[0].remoteUrl).toBe(`http://127.0.0.1:${port}/alternate.png`);
  });

  it('keeps failed image downloads as text output instead of failing the task', async () => {
    const task: BatchTask = {
      id: 'task-bad-image',
      row_no: 2,
      input: {
        book_id: 1,
        paragraph_content: '段落',
        chapter_sort: 1
      },
      status: 'running',
      attempts: 1,
      result_files: []
    };

    await applyDifyResult(task, {
      workflowRunId: 'run-bad-image',
      taskId: 'dify-bad-image',
      outputs: {
        image_url: 'https://example.com/result.png'
      },
      raw: {}
    });

    expect(task.result_files).toHaveLength(0);
    expect(task.result_text).toBe('https://example.com/result.png');
  });
});
