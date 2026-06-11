import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDifyWorkflowConfigs } from './dify.js';
import { registerWorkflowRoutes } from './workflowRoutes.js';
import { closeStoreForTest } from './store.js';
import { createWorkflowGroup, listWorkflowConfigs, listWorkflowGroups, updateWorkflowGroup, updateWorkflowGroupWorkflow } from './workflowConfigs.js';
import type { ManagedWorkflowConfig, ManagedWorkflowGroup } from './types.js';

async function withWorkflowApp(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerWorkflowRoutes(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      (server as Server).close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('workflow configs', () => {
  beforeEach(() => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-workflows-${Date.now()}-${Math.random()}.sqlite`);
    process.env.DIFY_API_BASE = 'http://primary.example/v1';
    process.env.DIFY_API_KEY = 'app-primary-env';
    process.env.DIFY_WORKFLOW_NAME = '线上环境工作流';
    process.env.DIFY_RESPONSE_MODE = 'streaming';
    process.env.DIFY_COMPARE_API_BASE = 'http://compare.example/v1';
    process.env.DIFY_COMPARE_API_KEY = 'app-compare-env';
    process.env.DIFY_COMPARE_WORKFLOW_NAME = '对照环境工作流';
    process.env.DIFY_COMPARE_RESPONSE_MODE = 'blocking';
  });

  afterEach(() => {
    closeStoreForTest();
    delete process.env.BATCH_STORE_PATH;
    delete process.env.DIFY_API_BASE;
    delete process.env.DIFY_API_KEY;
    delete process.env.DIFY_WORKFLOW_NAME;
    delete process.env.DIFY_RESPONSE_MODE;
    delete process.env.DIFY_COMPARE_API_BASE;
    delete process.env.DIFY_COMPARE_API_KEY;
    delete process.env.DIFY_COMPARE_WORKFLOW_NAME;
    delete process.env.DIFY_COMPARE_RESPONSE_MODE;
  });

  it('seeds primary and compare workflows from environment', () => {
    expect(listWorkflowConfigs()).toMatchObject([
      { id: 'primary', name: '线上环境工作流', api_key: 'app-primary-env' },
      { id: 'compare', name: '对照环境工作流', api_key: 'app-compare-env' }
    ]);
    expect(listWorkflowGroups()[0]).toMatchObject({
      id: 'default',
      name: '默认分组',
      status: 'active',
      is_default: true
    });
  });

  it('updates workflow fields through API and keeps them persisted', async () => {
    await withWorkflowApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workflows/primary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '新版主工作流',
          api_key: 'app-primary-updated',
          console_url: 'https://dify.example/workflow/primary',
          note: '线上主链路'
        })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { workflow: ManagedWorkflowConfig };
      expect(payload.workflow).toMatchObject({
        id: 'primary',
        name: '新版主工作流',
        api_key: 'app-primary-updated',
        console_url: 'https://dify.example/workflow/primary',
        note: '线上主链路'
      });

      const listResponse = await fetch(`${baseUrl}/api/workflows`);
      const listPayload = (await listResponse.json()) as { workflows: ManagedWorkflowConfig[] };
      expect(listPayload.workflows[0]).toMatchObject({
        id: 'primary',
        name: '新版主工作流',
        api_key: 'app-primary-updated'
      });
    });
  });

  it('rejects unknown workflow ids', async () => {
    await withWorkflowApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workflows/unknown`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'unknown' })
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: '工作流不存在' });
    });
  });

  it('creates workflow groups and updates group scoped workflow fields through API', async () => {
    await withWorkflowApp(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/workflow-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'hu-v2', name: 'HU 第二版', note: '测试分组' })
      });
      expect(createResponse.status).toBe(200);
      const createPayload = (await createResponse.json()) as { group: ManagedWorkflowGroup };
      expect(createPayload.group).toMatchObject({
        id: 'hu-v2',
        name: 'HU 第二版',
        status: 'active'
      });
      expect(createPayload.group.workflows).toMatchObject([
        { id: 'primary', name: '主工作流' },
        { id: 'compare', name: '对照工作流' }
      ]);

      const updateResponse = await fetch(`${baseUrl}/api/workflow-groups/hu-v2/workflows/compare`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'HU 对照', api_key: 'app-hu-compare' })
      });
      expect(updateResponse.status).toBe(200);
      const updatePayload = (await updateResponse.json()) as { group: ManagedWorkflowGroup };
      expect(updatePayload.group.workflows.find((workflow) => workflow.id === 'compare')).toMatchObject({
        name: 'HU 对照',
        api_key: 'app-hu-compare'
      });
    });
  });

  it('blocks disabled workflow groups from active list and Dify execution binding', () => {
    createWorkflowGroup({ id: 'disabled-group', name: '禁用分组' });
    updateWorkflowGroup('disabled-group', { status: 'disabled' });

    expect(listWorkflowGroups(false).map((group) => group.id)).not.toContain('disabled-group');
  });

  it('uses persisted name and key while preserving env api base and response mode', async () => {
    await withWorkflowApp(async (baseUrl) => {
      await fetch(`${baseUrl}/api/workflows/compare`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新版对照工作流', api_key: 'app-compare-updated' })
      });
    });

    expect(getDifyWorkflowConfigs()).toMatchObject([
      {
        id: 'primary',
        name: '线上环境工作流',
        apiBase: 'http://primary.example/v1',
        apiKey: 'app-primary-env',
        responseMode: 'streaming'
      },
      {
        id: 'compare',
        name: '新版对照工作流',
        apiBase: 'http://compare.example/v1',
        apiKey: 'app-compare-updated',
        responseMode: 'blocking'
      }
    ]);
  });

  it('uses group scoped persisted workflow name and key for Dify configs', () => {
    createWorkflowGroup({ id: 'image-test', name: '图像测试分组' });
    updateWorkflowGroupWorkflow('image-test', 'primary', { name: '图像主流程', api_key: 'app-image-primary' });
    updateWorkflowGroupWorkflow('image-test', 'compare', { name: '图像对照流程', api_key: 'app-image-compare' });

    expect(getDifyWorkflowConfigs('image-test')).toMatchObject([
      {
        id: 'primary',
        groupId: 'image-test',
        groupName: '图像测试分组',
        name: '图像主流程',
        apiKey: 'app-image-primary',
        apiBase: 'http://primary.example/v1'
      },
      {
        id: 'compare',
        groupId: 'image-test',
        groupName: '图像测试分组',
        name: '图像对照流程',
        apiKey: 'app-image-compare',
        apiBase: 'http://compare.example/v1'
      }
    ]);
  });
});
