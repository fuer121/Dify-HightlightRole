import { describe, expect, it } from 'vitest';
import type { ParsedWorkbook } from './types.js';
import { createBatch } from './queue.js';

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
  it('creates tasks and marks validation failures', () => {
    const batch = createBatch(workbook, 'Sheet1', {
      book_id: 'book_id',
      paragraph_content: 'paragraph_content',
      chapter_sort: 'chapter_sort'
    });

    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0].status).toBe('queued');
    expect(batch.tasks[1].status).toBe('failed');
    expect(batch.tasks[1].error).toContain('字段校验失败');
  });
});
