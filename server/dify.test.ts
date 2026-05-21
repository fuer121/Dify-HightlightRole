import { describe, expect, it } from 'vitest';
import { __testables } from './dify.js';

describe('dify helpers', () => {
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
});
