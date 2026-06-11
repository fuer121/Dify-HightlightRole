import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Batch } from './types.js';
import { __setLarkCliRunnerForTest, exportBatchToLark } from './lark.js';

describe('lark export', () => {
  afterEach(() => {
    __setLarkCliRunnerForTest();
  });

  it('exports each Dify workflow result into a workflow-named attachment field', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dify-lark-export-'));
    const primaryFile = path.join(tempDir, 'primary.png');
    const compareFile = path.join(tempDir, 'compare.png');
    await writeFile(primaryFile, Buffer.from('primary'));
    await writeFile(compareFile, Buffer.from('compare'));

    const calls: string[][] = [];
    __setLarkCliRunnerForTest(async (args) => {
      calls.push(args);
      if (args.includes('+base-create')) {
        const json = { token: 'base-token', url: 'https://example.feishu.cn/base/base-token' };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { table_id: 'tbl-test' };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const json = { record_id_list: ['rec-test'] };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-upload-attachment')) {
        return { stdout: '{}', stderr: '' };
      }
      throw new Error(`unexpected lark call: ${args.join(' ')}`);
    });

    const batch: Batch = {
      id: 'batch-1',
      workbookId: 'workbook-1',
      sheetName: 'Sheet1',
      fileName: 'sample.xlsx',
      mapping: {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      },
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pauseRequested: false,
      tasks: [
        {
          id: 'task-1',
          row_no: 2,
          input: {
            book_id: 1,
            paragraph_content: '高光段落',
            chapter_sort: 1
          },
          status: 'succeeded',
          attempts: 1,
          result_files: [],
          workflow_results: [
            {
              workflow_id: 'primary',
              workflow_name: '线上工作流',
              status: 'succeeded',
              result_files: [
                {
                  id: 'primary-file',
                  taskId: 'task-1',
                  name: 'primary.png',
                  mimeType: 'image/png',
                  previewUrl: '/api/files/primary-file',
                  localPath: primaryFile,
                  sourceKind: 'local'
                }
              ]
            },
            {
              workflow_id: 'compare',
              workflow_name: '对照工作流',
              status: 'succeeded',
              result_files: [
                {
                  id: 'compare-file',
                  taskId: 'task-1',
                  name: 'compare.png',
                  mimeType: 'image/png',
                  previewUrl: '/api/files/compare-file',
                  localPath: compareFile,
                  sourceKind: 'local'
                }
              ]
            }
          ]
        }
      ],
      events: []
    };

    const result = await exportBatchToLark(batch);
    await rm(tempDir, { recursive: true, force: true });

    const tableCreateCall = calls.find((args) => args.includes('+table-create'));
    const fieldsArg = tableCreateCall?.[tableCreateCall.indexOf('--fields') + 1] ?? '[]';
    const fieldNames = (JSON.parse(fieldsArg) as Array<{ name: string }>).map((field) => field.name);
    const uploadFieldNames = calls
      .filter((args) => args.includes('+record-upload-attachment'))
      .map((args) => args[args.indexOf('--field-id') + 1]);

    expect(result.attachmentsUploaded).toBe(2);
    expect(fieldNames).toEqual(expect.arrayContaining(['线上工作流', '对照工作流']));
    expect(uploadFieldNames).toEqual(expect.arrayContaining(['线上工作流', '对照工作流']));
  });
});
