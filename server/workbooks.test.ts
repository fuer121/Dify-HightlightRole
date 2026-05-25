import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { autoMapHeaders, compileRows, normalizeUploadFileName, parseWorkbook } from './workbooks.js';

function workbookBuffer(rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

describe('workbooks', () => {
  it('auto maps Chinese and English headers', () => {
    expect(autoMapHeaders(['书籍id', '段落内容', '章节序号'])).toEqual({
      book_id: '书籍id',
      paragraph_content: '段落内容',
      chapter_sort: '章节序号'
    });

    expect(autoMapHeaders(['book_id', 'paragraph_content', 'chapter_sort'])).toEqual({
      book_id: 'book_id',
      paragraph_content: 'paragraph_content',
      chapter_sort: 'chapter_sort'
    });
  });

  it('parses workbook and compiles valid rows', () => {
    const workbook = parseWorkbook(
      workbookBuffer([
        ['书籍id', '段落内容', '章节序号'],
        [12, '高光段落', 3]
      ]),
      'sample.xlsx'
    );

    const rows = compileRows(workbook.sheets[0], {
      book_id: '书籍id',
      paragraph_content: '段落内容',
      chapter_sort: '章节序号'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_no: 2,
      input: {
        book_id: 12,
        paragraph_content: '高光段落',
        chapter_sort: 3
      }
    });
  });

  it('limits compiled rows after empty rows are filtered', () => {
    const workbook = parseWorkbook(
      workbookBuffer([
        ['book_id', 'paragraph_content', 'chapter_sort'],
        [1, '第一段', 1],
        ['', '', ''],
        [2, '第二段', 2],
        [3, '第三段', 3]
      ]),
      'limited.xlsx'
    );

    const rows = compileRows(
      workbook.sheets[0],
      {
        book_id: 'book_id',
        paragraph_content: 'paragraph_content',
        chapter_sort: 'chapter_sort'
      },
      { rowLimit: 2 }
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.row_no)).toEqual([2, 4]);
  });

  it('normalizes mojibake Chinese upload file names', () => {
    const fileName = '废材那又怎样-高光段落_100 条.xlsx';
    const mojibakeName = Buffer.from(fileName, 'utf8').toString('latin1');

    expect(normalizeUploadFileName(mojibakeName)).toBe(fileName);
    expect(normalizeUploadFileName(fileName)).toBe(fileName);
    expect(normalizeUploadFileName('sample.xlsx')).toBe('sample.xlsx');
  });

  it('keeps invalid rows with validation errors', () => {
    const workbook = parseWorkbook(
      workbookBuffer([
        ['book_id', 'paragraph_content', 'chapter_sort'],
        ['oops', '', 1]
      ]),
      'bad.xlsx'
    );

    const rows = compileRows(workbook.sheets[0], {
      book_id: 'book_id',
      paragraph_content: 'paragraph_content',
      chapter_sort: 'chapter_sort'
    });

    expect(rows[0].error).toContain('书籍 ID 必须是数字');
  });
});
