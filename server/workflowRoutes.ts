import express from 'express';
import {
  createWorkflowGroup,
  isManagedWorkflowId,
  isWorkflowGroupStatus,
  listWorkflowConfigs,
  listWorkflowGroups,
  updateWorkflowConfig,
  updateWorkflowGroup,
  updateWorkflowGroupWorkflow
} from './workflowConfigs.js';

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

  app.get('/api/workflow-groups', (_req, res) => {
    res.json({ groups: listWorkflowGroups() });
  });

  app.post('/api/workflow-groups', (req, res) => {
    try {
      const group = createWorkflowGroup({
        id: stringPatchValue(req.body.id) ?? '',
        name: stringPatchValue(req.body.name) ?? '',
        note: stringPatchValue(req.body.note)
      });
      res.json({ group });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '创建 Workflow 分组失败' });
    }
  });

  app.patch('/api/workflow-groups/:groupId', (req, res) => {
    try {
      const status = stringPatchValue(req.body.status);
      const group = updateWorkflowGroup(req.params.groupId, {
        name: stringPatchValue(req.body.name),
        status: status && isWorkflowGroupStatus(status) ? status : undefined,
        note: stringPatchValue(req.body.note)
      });
      res.json({ group });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '保存 Workflow 分组失败' });
    }
  });

  app.patch('/api/workflow-groups/:groupId/workflows/:workflowId', (req, res) => {
    const workflowId = req.params.workflowId;
    if (!isManagedWorkflowId(workflowId)) {
      res.status(404).json({ error: '工作流不存在' });
      return;
    }
    try {
      const group = updateWorkflowGroupWorkflow(req.params.groupId, workflowId, {
        name: stringPatchValue(req.body.name),
        api_key: stringPatchValue(req.body.api_key),
        console_url: stringPatchValue(req.body.console_url),
        note: stringPatchValue(req.body.note)
      });
      res.json({ group });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '保存 Workflow 配置失败' });
    }
  });
}
