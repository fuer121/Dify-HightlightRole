import { nanoid } from 'nanoid';
import * as XLSX from 'xlsx';
import type {
  CharacterColumnMapping,
  CharacterInputKey,
  ColumnMapping,
  ParsedSheet,
  ParsedWorkbook,
  RequiredInputKey
} from './types.js';

const REQUIRED_KEYS: RequiredInputKey[] = ['book_id', 'paragraph_content', 'chapter_sort'];

const HEADER_ALIASES: Record<RequiredInputKey, string[]> = {
  book_id: ['book_id', 'bookid', '书籍id', '书籍ID', '书籍 id', '书籍编号'],
  paragraph_content: ['paragraph_content', 'paragraph', 'content', '段落内容', '高光段落', '正文', '片段内容'],
  chapter_sort: ['chapter_sort', 'chaptersort', '章节序号', '章节', '章节排序', 'chapter']
};

const CHARACTER_HEADER_ALIASES: Record<CharacterInputKey, string[]> = {
  novel_name: ['novel_name', 'book_title', '小说名', '书名', '作品名'],
  chapter_sort: ['chapter_sort', 'chaptersort', '章节序号', '章节', '章节排序', 'chapter'],
  chapter_name: ['chapter_name', 'chapter_title', '章节名', '章节标题'],
  paragraph_content: ['paragraph_content', 'paragraph', 'content', '段落内容', '高光段落', '正文', '片段内容'],
  paragraph_image_url: [
    'paragraph_image_url',
    'hightlight_image_url',
    'highlight_image_url',
    'image_url',
    '段落图片',
    '段落图片cdn链接',
    '高光场景图',
    '图片链接'
  ],
  role_name: ['role_name', 'roles', '角色名', '角色', '人物名']
};

const normalizeHeader = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_-]+/g, '');

export function normalizeUploadFileName(fileName: string) {
  const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
  const hasReplacementChar = decoded.includes('\uFFFD');
  const originalHasCjk = /[\u3400-\u9fff]/.test(fileName);
  const decodedHasCjk = /[\u3400-\u9fff]/.test(decoded);
  const mojibakeMarkerCount = fileName.match(/[ÃÂâåæçèéäöü]/g)?.length ?? 0;

  if (!hasReplacementChar && !originalHasCjk && decodedHasCjk && mojibakeMarkerCount >= 2) {
    return decoded;
  }

  return fileName;
}

export function autoMapHeaders(headers: string[]): Partial<ColumnMapping> {
  const normalized = headers.map((header) => ({
    header,
    normalized: normalizeHeader(header)
  }));

  const mapping: Partial<ColumnMapping> = {};
  for (const key of REQUIRED_KEYS) {
    const aliases = HEADER_ALIASES[key].map(normalizeHeader);
    const hit = normalized.find((item) => aliases.includes(item.normalized));
    if (hit) {
      mapping[key] = hit.header;
    }
  }
  return mapping;
}

export function autoMapCharacterHeaders(headers: string[]): Partial<CharacterColumnMapping> {
  const normalized = headers.map((header) => ({
    header,
    normalized: normalizeHeader(header)
  }));

  const mapping: Partial<CharacterColumnMapping> = {};
  for (const key of Object.keys(CHARACTER_HEADER_ALIASES) as CharacterInputKey[]) {
    const aliases = CHARACTER_HEADER_ALIASES[key].map(normalizeHeader);
    const hit = normalized.find((item) => aliases.includes(item.normalized));
    if (hit) {
      mapping[key] = hit.header;
    }
  }
  return mapping;
}

function stringifyHeader(value: unknown, index: number) {
  const text = String(value ?? '').trim();
  return text || `未命名列 ${index + 1}`;
}

function normalizeCell(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}

function rowsFromSheet(sheet: XLSX.WorkSheet): ParsedSheet['rows'] & { headers?: string[] } {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false
  });

  if (matrix.length === 0) {
    return Object.assign([], { headers: [] });
  }

  const headerRow = matrix[0] ?? [];
  const headers = headerRow.map(stringifyHeader);
  const rows = matrix.slice(1).map((row, rowIndex) => {
    const record: Record<string, unknown> = { __row_no: rowIndex + 2 };
    headers.forEach((header, columnIndex) => {
      record[header] = normalizeCell(row[columnIndex] ?? '');
    });
    return record;
  });

  return Object.assign(rows, { headers });
}

export function parseWorkbook(buffer: Buffer, fileName: string): ParsedWorkbook {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true
  });

  const sheets: ParsedSheet[] = workbook.SheetNames.map((name) => {
    const rows = rowsFromSheet(workbook.Sheets[name]);
    const headers = rows.headers ?? [];
    return {
      name,
      headers,
      rows,
      previewRows: rows.slice(0, 8),
      rowCount: rows.length,
      autoMapping: autoMapHeaders(headers),
      characterAutoMapping: autoMapCharacterHeaders(headers)
    };
  });

  return {
    id: nanoid(),
    fileName: normalizeUploadFileName(fileName),
    sheets,
    createdAt: new Date().toISOString()
  };
}

function parseNumber(value: unknown, label: string) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`${label} 为空`);
  }
  const normalized = text.replace(/,/g, '');
  const numberValue = Number(normalized);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${label} 必须是数字`);
  }
  return numberValue;
}

function parseParagraph(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error('段落内容为空');
  }
  if (text.length > 100000) {
    throw new Error('段落内容超过 100000 字符');
  }
  return text;
}

interface CompileRowsOptions {
  rowLimit?: number;
}

interface CompileCharacterRowsOptions {
  rowLimit?: number;
}

export function compileRows(sheet: ParsedSheet, mapping: ColumnMapping, options: CompileRowsOptions = {}) {
  const missing = REQUIRED_KEYS.filter((key) => !mapping[key] || !sheet.headers.includes(mapping[key]));
  if (missing.length > 0) {
    throw new Error(`字段映射缺失：${missing.join(', ')}`);
  }

  return sheet.rows
    .filter((row) => sheet.headers.some((header) => String(row[header] ?? '').trim() !== ''))
    .slice(0, options.rowLimit)
    .map((row) => {
      const rowNo = Number(row.__row_no ?? 0);
      try {
        return {
          row_no: rowNo,
          input: {
            book_id: parseNumber(row[mapping.book_id], '书籍 ID'),
            paragraph_content: parseParagraph(row[mapping.paragraph_content]),
            chapter_sort: parseNumber(row[mapping.chapter_sort], '章节序号')
          },
          error: undefined
        };
      } catch (error) {
        return {
          row_no: rowNo,
          input: {
            book_id: Number(row[mapping.book_id]) || 0,
            paragraph_content: String(row[mapping.paragraph_content] ?? ''),
            chapter_sort: Number(row[mapping.chapter_sort]) || 0
          },
          error: error instanceof Error ? error.message : '字段校验失败'
        };
      }
    });
}

function parseText(value: unknown, label: string) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} 为空`);
  return text;
}

function parseImageUrl(value: unknown) {
  const text = parseText(value, '段落图片链接');
  if (!/^https?:\/\//i.test(text)) {
    throw new Error('段落图片链接必须是 http/https 地址');
  }
  return text;
}

export function compileCharacterRows(sheet: ParsedSheet, mapping: CharacterColumnMapping, options: CompileCharacterRowsOptions = {}) {
  const requiredKeys = Object.keys(CHARACTER_HEADER_ALIASES) as CharacterInputKey[];
  const missing = requiredKeys.filter((key) => !mapping[key] || !sheet.headers.includes(mapping[key]));
  if (missing.length > 0) {
    throw new Error(`字段映射缺失：${missing.join(', ')}`);
  }

  return sheet.rows
    .filter((row) => sheet.headers.some((header) => String(row[header] ?? '').trim() !== ''))
    .slice(0, options.rowLimit)
    .map((row) => {
      const rowNo = Number(row.__row_no ?? 0);
      try {
        return {
          row_no: rowNo,
          input: {
            novel_name: parseText(row[mapping.novel_name], '小说名'),
            chapter_sort: parseNumber(row[mapping.chapter_sort], '章节序号'),
            chapter_name: parseText(row[mapping.chapter_name], '章节名'),
            paragraph_content: parseParagraph(row[mapping.paragraph_content]),
            paragraph_image_url: parseImageUrl(row[mapping.paragraph_image_url]),
            role_name: parseText(row[mapping.role_name], '角色名')
          },
          error: undefined
        };
      } catch (error) {
        return {
          row_no: rowNo,
          input: {
            novel_name: String(row[mapping.novel_name] ?? ''),
            chapter_sort: Number(row[mapping.chapter_sort]) || 0,
            chapter_name: String(row[mapping.chapter_name] ?? ''),
            paragraph_content: String(row[mapping.paragraph_content] ?? ''),
            paragraph_image_url: String(row[mapping.paragraph_image_url] ?? ''),
            role_name: String(row[mapping.role_name] ?? '')
          },
          error: error instanceof Error ? error.message : '字段校验失败'
        };
      }
    });
}

export { REQUIRED_KEYS };
