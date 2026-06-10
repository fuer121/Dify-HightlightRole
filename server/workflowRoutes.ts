import express from 'express';
import { isManagedWorkflowId, listWorkflowConfigs, updateWorkflowConfig } from './workflowConfigs.js';

function stringPatchValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function registerWorkflowRoutes(app: express.Express) {
  app.get('/api/workflows', (_req, res) => {
    res.json({ workflows: listWorkflowConfigs() });
  });

  app.patch('/api/workflows/:id', (req, res) => {
    const workflowId = req.params.id;
    if (!isManagedWorkflowId(workflowId)) {
      res.status(404).json({ error: '工作流不存在' });
      return;
    }

    const workflow = updateWorkflowConfig(workflowId, {
      name: stringPatchValue(req.body.name),
      api_key: stringPatchValue(req.body.api_key),
      console_url: stringPatchValue(req.body.console_url),
      note: stringPatchValue(req.body.note)
    });
    res.json({ workflow });
  });
}
