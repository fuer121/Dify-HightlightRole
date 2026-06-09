import type express from 'express';
import type { CharacterColumnMapping, ParsedWorkbook } from './types.js';
import {
  createCharacterJob,
  getCharacterJob,
  getCharacterTaskRuns,
  listCharacterJobs,
  pauseCharacterJob,
  retryCharacterFailed,
  retryCharacterTask,
  startCharacterJob,
  subscribeCharacterJob
} from './characters.js';

interface RegisterCharacterRouteOptions {
  getWorkbook: (workbookId: string) => ParsedWorkbook | undefined;
}

function asyncHandler<TReq extends express.Request, TRes extends express.Response>(
  handler: (req: TReq, res: TRes) => Promise<void>
) {
  return (req: TReq, res: TRes, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function registerCharacterRoutes(app: express.Express, options: RegisterCharacterRouteOptions) {
  app.get('/api/character-jobs', (_req, res) => {
    res.json({ jobs: listCharacterJobs() });
  });

  app.post(
    '/api/character-jobs',
    asyncHandler(async (req, res) => {
      const { workbookId, sheetName, mapping, promptText } = req.body as {
        workbookId?: string;
        sheetName?: string;
        mapping?: CharacterColumnMapping;
        promptText?: string;
      };
      if (!workbookId || !sheetName || !mapping || !promptText?.trim()) {
        res.status(400).json({ error: '缺少 workbookId、sheetName、mapping 或 promptText' });
        return;
      }
      const workbook = options.getWorkbook(workbookId);
      if (!workbook) {
        res.status(404).json({ error: '工作簿不存在，请重新上传' });
        return;
      }
      const job = createCharacterJob(workbook, sheetName, mapping, promptText.trim());
      res.json(job);
    })
  );

  app.get('/api/character-jobs/:id', (req, res) => {
    const job = getCharacterJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '角色任务不存在' });
      return;
    }
    res.json(job);
  });

  app.post('/api/character-jobs/:id/start', (req, res) => {
    const { taskIds } = req.body as { taskIds?: unknown };
    if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== 'string'))) {
      res.status(400).json({ error: 'taskIds 必须是字符串数组' });
      return;
    }
    const job = startCharacterJob(req.params.id, taskIds);
    res.json(job);
  });

  app.post('/api/character-jobs/:id/pause', (req, res) => {
    const job = pauseCharacterJob(req.params.id);
    res.json(job);
  });

  app.post('/api/character-jobs/:id/retry-failed', (req, res) => {
    const job = retryCharacterFailed(req.params.id);
    res.json(job);
  });

  app.post('/api/character-jobs/:jobId/tasks/:taskId/retry', (req, res) => {
    const job = retryCharacterTask(req.params.jobId, req.params.taskId);
    res.json(job);
  });

  app.get('/api/character-jobs/:id/events', (req, res) => {
    const job = getCharacterJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '角色任务不存在' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    const unsubscribe = subscribeCharacterJob(job.id, (nextJob) => {
      res.write(`data: ${JSON.stringify(nextJob)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.get('/api/character-tasks/:taskId/runs', (req, res) => {
    res.json({ runs: getCharacterTaskRuns(req.params.taskId) });
  });
}
