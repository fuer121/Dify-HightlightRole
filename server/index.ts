import dotenv from 'dotenv';

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parseWorkbook } from './workbooks.js';
import type { ColumnMapping, ParsedWorkbook } from './types.js';
import {
  addManualBookTask,
  appendWorkbookTasksToBook,
  continueBook,
  createBatch,
  deleteBatch,
  deleteTask,
  getBookDetail,
  getBatch,
  getTaskRuns,
  hydrateBatchesFromStore,
  listBatchesForBook,
  listBookSummaries,
  listTasksForBook,
  markExported,
  pauseBatch,
  pauseStoredTask,
  renameBatch,
  renameBook,
  pauseTask,
  retryFailed,
  retryStoredTask,
  retryTask,
  serializeBatch,
  startBatch,
  startSelectedTasks,
  deleteStoredTask,
  subscribeBatch
} from './queue.js';
import { FileUnavailableError, streamFile } from './fileStore.js';
import { exportBatchToLark } from './lark.js';
import { registerQualityRoutes } from './quality.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 5174);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const workbooks = new Map<string, ParsedWorkbook>();
hydrateBatchesFromStore();

app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    config: {
      hasDifyApiKey: Boolean(process.env.DIFY_API_KEY),
      difyApiBase: process.env.DIFY_API_BASE ?? null,
      difyResponseMode: process.env.DIFY_RESPONSE_MODE ?? null,
      difyWorkflowName: process.env.DIFY_WORKFLOW_NAME ?? 'LL-段落高光生图-效果测试',
      hasQualityDifyApiKey: Boolean(process.env.QUALITY_DIFY_API_KEY ?? process.env.DIFY_QUALITY_API_KEY),
      qualityDifyApiBase: process.env.QUALITY_DIFY_API_BASE ?? process.env.DIFY_API_BASE ?? null,
      qualityDifyResponseMode: process.env.QUALITY_DIFY_RESPONSE_MODE ?? null
    }
  });
});

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseBookIdParam(value: string | string[] | undefined) {
  const raw = routeParam(value);
  const bookId = Number(raw);
  if (!raw || !Number.isFinite(bookId)) {
    throw new Error('书籍 ID 必须是数字');
  }
  return bookId;
}

function parseOptionalNumber(value: unknown) {
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined;
}

function parseBookTaskFilters(query: Record<string, unknown>) {
  return {
    status: typeof query.status === 'string' ? query.status : undefined,
    q: typeof query.q === 'string' ? query.q : undefined,
    batchId: typeof query.batchId === 'string' ? query.batchId : undefined,
    hasImage: typeof query.hasImage === 'string' ? query.hasImage : undefined,
    valueStatus: typeof query.valueStatus === 'string' ? query.valueStatus : undefined,
    chapterSortFrom: parseOptionalNumber(query.chapterSortFrom),
    chapterSortTo: parseOptionalNumber(query.chapterSortTo),
    rowNoFrom: parseOptionalNumber(query.rowNoFrom),
    rowNoTo: parseOptionalNumber(query.rowNoTo)
  };
}

function asyncHandler<TReq extends express.Request, TRes extends express.Response>(
  handler: (req: TReq, res: TRes) => Promise<void>
) {
  return (req: TReq, res: TRes, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

function sendUnavailableImage(res: express.Response, message: string) {
  const escapedMessage = message.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    };
    return entities[char] ?? char;
  });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <rect width="640" height="420" rx="24" fill="#f5f7fb"/>
  <rect x="52" y="52" width="536" height="316" rx="18" fill="#ffffff" stroke="#d8dee9" stroke-width="2"/>
  <path d="M184 264l76-84 62 66 44-44 90 98H148z" fill="#d9e2ef"/>
  <circle cx="430" cy="136" r="34" fill="#c9d5e6"/>
  <text x="320" y="326" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#39465e">图片暂不可读</text>
  <text x="320" y="354" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#6b768a">${escapedMessage}</text>
</svg>`);
}

app.post(
  '/api/workbooks',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: '请上传 Excel 或 CSV 文件' });
      return;
    }
    const workbook = parseWorkbook(req.file.buffer, req.file.originalname);
    workbooks.set(workbook.id, workbook);
    res.json(workbook);
  })
);

app.post(
  '/api/batches',
  asyncHandler(async (req, res) => {
    const { workbookId, sheetName, mapping } = req.body as {
      workbookId?: string;
      sheetName?: string;
      mapping?: ColumnMapping;
      rowLimit?: unknown;
    };

    if (!workbookId || !sheetName || !mapping) {
      res.status(400).json({ error: '缺少 workbookId、sheetName 或 mapping' });
      return;
    }

    const workbook = workbooks.get(workbookId);
    if (!workbook) {
      res.status(404).json({ error: '工作簿不存在，请重新上传' });
      return;
    }

    let rowLimit: number | undefined;
    if (req.body.rowLimit !== undefined && req.body.rowLimit !== null && req.body.rowLimit !== '') {
      const parsed = Number(req.body.rowLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: '入队行数必须是大于 0 的整数' });
        return;
      }
      rowLimit = parsed;
    }

    const batch = createBatch(workbook, sheetName, mapping, { rowLimit });
    res.json(serializeBatch(batch));
  })
);

app.get('/api/batches/:id', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: '任务清单不存在' });
    return;
  }
  res.json(serializeBatch(batch));
});

app.patch('/api/batches/:id', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const batch = renameBatch(req.params.id, name);
  res.json(serializeBatch(batch));
});

app.delete(
  '/api/batches/:id',
  asyncHandler(async (req, res) => {
    const batchId = routeParam(req.params.id);
    if (!batchId) {
      res.status(400).json({ error: '缺少任务清单 ID' });
      return;
    }
    await deleteBatch(batchId);
    res.json({ ok: true });
  })
);

app.post('/api/batches/:id/start', (req, res) => {
  const batch = startBatch(req.params.id);
  res.json(serializeBatch(batch));
});

app.post('/api/batches/:id/start-selected', (req, res) => {
  const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.filter((item: unknown) => typeof item === 'string') : [];
  if (taskIds.length === 0) {
    res.status(400).json({ error: '请选择要生成的任务' });
    return;
  }
  const batch = startSelectedTasks(req.params.id, taskIds);
  res.json(serializeBatch(batch));
});

app.post('/api/batches/:id/pause', (req, res) => {
  const batch = pauseBatch(req.params.id);
  res.json(serializeBatch(batch));
});

app.post('/api/batches/:id/retry-failed', (req, res) => {
  const batch = retryFailed(req.params.id);
  res.json(serializeBatch(batch));
});

app.post(
  '/api/batches/:batchId/tasks/:taskId/pause',
  asyncHandler(async (req, res) => {
    const batchId = routeParam(req.params.batchId);
    const taskId = routeParam(req.params.taskId);
    if (!batchId || !taskId) {
      res.status(400).json({ error: '缺少任务清单 ID 或任务 ID' });
      return;
    }
    const batch = await pauseTask(batchId, taskId);
    res.json(serializeBatch(batch));
  })
);

app.post('/api/batches/:batchId/tasks/:taskId/retry', (req, res) => {
  const batchId = routeParam(req.params.batchId);
  const taskId = routeParam(req.params.taskId);
  if (!batchId || !taskId) {
    res.status(400).json({ error: '缺少任务清单 ID 或任务 ID' });
    return;
  }
  const batch = retryTask(batchId, taskId);
  res.json(serializeBatch(batch));
});

app.delete(
  '/api/batches/:batchId/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const batchId = routeParam(req.params.batchId);
    const taskId = routeParam(req.params.taskId);
    if (!batchId || !taskId) {
      res.status(400).json({ error: '缺少任务清单 ID 或任务 ID' });
      return;
    }
    const batch = await deleteTask(batchId, taskId);
    res.json(serializeBatch(batch));
  })
);

app.get('/api/batches/:id/events', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: '任务清单不存在' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify(serializeBatch(batch))}\n\n`);

  const unsubscribe = subscribeBatch(batch.id, (nextBatch) => {
    res.write(`data: ${JSON.stringify(serializeBatch(nextBatch))}\n\n`);
  });

  req.on('close', unsubscribe);
});

app.get('/api/books', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ books: listBookSummaries(q) });
});

app.get('/api/books/:bookId', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  const book = getBookDetail(bookId);
  if (!book) {
    res.status(404).json({ error: '书籍不存在' });
    return;
  }
  res.json(book);
});

app.patch('/api/books/:bookId', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const book = renameBook(bookId, name);
  if (!book) {
    res.status(404).json({ error: '书籍不存在' });
    return;
  }
  res.json(book);
});

app.get('/api/books/:bookId/batches', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  res.json({ batches: listBatchesForBook(bookId) });
});

app.get('/api/books/:bookId/tasks', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  const filters = parseBookTaskFilters(req.query);
  const pageRaw = typeof req.query.page === 'string' && req.query.page.trim() !== '' ? Number(req.query.page) : 1;
  const pageSizeRaw = typeof req.query.pageSize === 'string' && req.query.pageSize.trim() !== '' ? Number(req.query.pageSize) : 50;
  if (
    (filters.chapterSortFrom !== undefined && !Number.isFinite(filters.chapterSortFrom)) ||
    (filters.chapterSortTo !== undefined && !Number.isFinite(filters.chapterSortTo))
  ) {
    res.status(400).json({ error: '章节序号筛选必须是数字' });
    return;
  }
  if (
    (filters.rowNoFrom !== undefined && !Number.isFinite(filters.rowNoFrom)) ||
    (filters.rowNoTo !== undefined && !Number.isFinite(filters.rowNoTo))
  ) {
    res.status(400).json({ error: '行数筛选必须是数字' });
    return;
  }
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    res.status(400).json({ error: '页码必须是正整数' });
    return;
  }
  if (![20, 50, 200].includes(pageSizeRaw)) {
    res.status(400).json({ error: '每页数量仅支持 20、50、200' });
    return;
  }
  const allTasks = listTasksForBook(bookId, filters);
  const runnableTotal = allTasks.filter(
    (task) => (task.status === 'queued' || task.status === 'paused' || task.status === 'failed') && !task.error?.startsWith('字段校验失败')
  ).length;
  const total = allTasks.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSizeRaw));
  const page = Math.min(pageRaw, totalPages);
  const offset = (page - 1) * pageSizeRaw;
  res.json({
    tasks: allTasks.slice(offset, offset + pageSizeRaw),
    pagination: {
      page,
      pageSize: pageSizeRaw,
      total,
      totalPages,
      runnableTotal
    }
  });
});

app.post('/api/books/:bookId/tasks', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  const task = addManualBookTask({
    book_id: bookId,
    paragraph_content: req.body?.paragraph_content,
    chapter_sort: req.body?.chapter_sort
  });
  res.json(task);
});

app.post(
  '/api/books/:bookId/import-tasks',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const bookId = parseBookIdParam(req.params.bookId);
    if (!req.file) {
      res.status(400).json({ error: '请上传 Excel 或 CSV 文件' });
      return;
    }
    const workbook = parseWorkbook(req.file.buffer, req.file.originalname);
    const sheet = workbook.sheets[0];
    if (!sheet) {
      res.status(400).json({ error: '工作簿没有可导入的工作表' });
      return;
    }
    const syntheticBookIdHeader = '__target_book_id';
    const importSheet =
      sheet.autoMapping.book_id === undefined
        ? {
            ...sheet,
            headers: [...sheet.headers, syntheticBookIdHeader],
            rows: sheet.rows.map((row) => ({ ...row, [syntheticBookIdHeader]: String(bookId) }))
          }
        : sheet;
    const mapping = {
      ...sheet.autoMapping,
      book_id: sheet.autoMapping.book_id ?? syntheticBookIdHeader
    } as ColumnMapping;
    if (!mapping.paragraph_content || !mapping.chapter_sort) {
      res.status(400).json({ error: '无法识别段落内容或章节序号列，请在批量生图页完成映射后导入' });
      return;
    }
    const tasks = appendWorkbookTasksToBook(bookId, { ...workbook, sheets: [importSheet] }, importSheet.name, mapping);
    res.json({ imported: tasks.length, tasks });
  })
);

app.post('/api/books/:bookId/continue', (req, res) => {
  const bookId = parseBookIdParam(req.params.bookId);
  const batch = continueBook(bookId, parseBookTaskFilters(req.query));
  res.json(serializeBatch(batch));
});

app.get('/api/tasks/:taskId/runs', (req, res) => {
  const taskId = routeParam(req.params.taskId);
  if (!taskId) {
    res.status(400).json({ error: '缺少任务 ID' });
    return;
  }
  res.json({ runs: getTaskRuns(taskId) });
});

app.post(
  '/api/tasks/:taskId/pause',
  asyncHandler(async (req, res) => {
    const taskId = routeParam(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: '缺少任务 ID' });
      return;
    }
    const result = await pauseStoredTask(taskId);
    res.json(result);
  })
);

app.post('/api/tasks/:taskId/retry', (req, res) => {
  const taskId = routeParam(req.params.taskId);
  if (!taskId) {
    res.status(400).json({ error: '缺少任务 ID' });
    return;
  }
  const result = retryStoredTask(taskId);
  res.json('tasks' in result ? serializeBatch(result) : result);
});

app.delete(
  '/api/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const taskId = routeParam(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: '缺少任务 ID' });
      return;
    }
    const result = await deleteStoredTask(taskId);
    res.json('tasks' in result ? serializeBatch(result) : result);
  })
);

app.post(
  '/api/batches/:id/export/lark',
  asyncHandler(async (req, res) => {
    const batchId = routeParam(req.params.id);
    if (!batchId) {
      res.status(400).json({ error: '缺少任务清单 ID' });
      return;
    }
    const batch = getBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: '任务清单不存在' });
      return;
    }
    if (batch.export) {
      res.json(batch.export);
      return;
    }
    const result = await exportBatchToLark(batch);
    batch.export = result;
    markExported(batch);
    res.json(result);
  })
);

app.get(
  '/api/files/:id',
  asyncHandler(async (req, res) => {
    const fileId = routeParam(req.params.id);
    if (!fileId) {
      res.status(400).json({ error: '缺少文件 ID' });
      return;
    }
    let streamed: Awaited<ReturnType<typeof streamFile>>;
    try {
      streamed = await streamFile(fileId);
    } catch (error) {
      if (error instanceof FileUnavailableError) {
        sendUnavailableImage(res, error.message);
        return;
      }
      throw error;
    }
    if (!streamed) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    res.setHeader('Content-Type', streamed.file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (streamed.size) {
      res.setHeader('Content-Length', String(streamed.size));
    }
    streamed.stream.pipe(res);
  })
);

registerQualityRoutes(app, {
  getWorkbook: (workbookId) => workbooks.get(workbookId)
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  const message = error instanceof Error ? error.message : '服务器错误';
  console.error('[api:error]', error);
  res.status(500).json({ error: message });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Dify batch server listening at http://127.0.0.1:${port}`);
});
