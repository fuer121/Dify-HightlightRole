import dotenv from 'dotenv';

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parseWorkbook } from './workbooks.js';
import type { ColumnMapping, ParsedWorkbook } from './types.js';
import {
  createBatch,
  deleteTask,
  getBatch,
  markExported,
  pauseBatch,
  pauseTask,
  retryFailed,
  retryTask,
  serializeBatch,
  startBatch,
  startSelectedTasks,
  subscribeBatch
} from './queue.js';
import { streamFile } from './fileStore.js';
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

app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    config: {
      hasDifyApiKey: Boolean(process.env.DIFY_API_KEY),
      difyApiBase: process.env.DIFY_API_BASE ?? null,
      difyResponseMode: process.env.DIFY_RESPONSE_MODE ?? null,
      hasQualityDifyApiKey: Boolean(process.env.QUALITY_DIFY_API_KEY ?? process.env.DIFY_QUALITY_API_KEY),
      qualityDifyApiBase: process.env.QUALITY_DIFY_API_BASE ?? process.env.DIFY_API_BASE ?? null,
      qualityDifyResponseMode: process.env.QUALITY_DIFY_RESPONSE_MODE ?? null
    }
  });
});

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function asyncHandler<TReq extends express.Request, TRes extends express.Response>(
  handler: (req: TReq, res: TRes) => Promise<void>
) {
  return (req: TReq, res: TRes, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
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
    res.status(404).json({ error: '批次不存在' });
    return;
  }
  res.json(serializeBatch(batch));
});

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
      res.status(400).json({ error: '缺少批次 ID 或任务 ID' });
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
    res.status(400).json({ error: '缺少批次 ID 或任务 ID' });
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
      res.status(400).json({ error: '缺少批次 ID 或任务 ID' });
      return;
    }
    const batch = await deleteTask(batchId, taskId);
    res.json(serializeBatch(batch));
  })
);

app.get('/api/batches/:id/events', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: '批次不存在' });
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

app.post(
  '/api/batches/:id/export/lark',
  asyncHandler(async (req, res) => {
    const batchId = routeParam(req.params.id);
    if (!batchId) {
      res.status(400).json({ error: '缺少批次 ID' });
      return;
    }
    const batch = getBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: '批次不存在' });
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
    const streamed = await streamFile(fileId);
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
  res.status(500).json({ error: message });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Dify batch server listening at http://127.0.0.1:${port}`);
});
