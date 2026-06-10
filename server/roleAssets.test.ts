import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setLarkCliRunnerForTest, type LarkCliRunner } from './lark.js';
import { registerRoleAssetRoutes } from './roleAssetRoutes.js';
import { closeStoreForTest } from './store.js';
import {
  addRoleAssetProfile,
  buildWorkflowRoleContext,
  createRoleAsset,
  importCharacterTaskToRoleAssets,
  isRoleAssetTokenAuthorized
} from './roleAssets.js';
import type { CharacterTask } from './types.js';

async function withRoleAssetApp(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerRoleAssetRoutes(app);
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

describe('role asset workflow context', () => {
  beforeEach(() => {
    process.env.BATCH_STORE_PATH = path.join(os.tmpdir(), `dify-role-assets-${Date.now()}-${Math.random()}.sqlite`);
    process.env.ROLE_ASSET_API_TOKEN = 'role-token';
  });

  afterEach(() => {
    __setLarkCliRunnerForTest();
    closeStoreForTest();
    delete process.env.BATCH_STORE_PATH;
    delete process.env.ROLE_ASSET_API_TOKEN;
    delete process.env.ROLE_ASSET_PUBLIC_BASE_URL;
  });

  it('returns old node compatible fields for an active single-role asset', () => {
    createRoleAsset({
      book_id: 1721648,
      novel_name: '第一瞳术师',
      role_name: '云筝',
      image_url: 'https://cdn.example.com/yunzheng.png',
      default_age: '十八岁',
      default_gender: '女',
      default_appearance: '红衣，长发，神情坚韧',
      status: 'active',
      source: 'manual'
    });

    const context = buildWorkflowRoleContext({
      book_id: 1721648,
      role_title: '角色:云筝 标题:云筝立于水中',
      describe: '云筝站在溪水中。',
      chapter_sort: 12
    });

    expect(context.role_list).toEqual(['云筝']);
    expect(context.highlight_content).toBe('云筝立于水中');
    expect(context.role_url).toBe('https://cdn.example.com/yunzheng.png');
    expect(context.role_url_describe).toContain('第1张图是云筝');
    expect(context.role_have_pic).toBe('云筝');
    expect(context.role_info).toContain('云筝(年龄十八岁,性别女,红衣，长发，神情坚韧)');
    expect(context.prompt).toContain('角色参考图规则');
  });

  it('prefers public local file URLs over temporary remote URLs', () => {
    process.env.ROLE_ASSET_PUBLIC_BASE_URL = 'http://172.16.79.76:5175';
    createRoleAsset({
      book_id: 215243,
      novel_name: '第一瞳术师',
      role_name: '楚允衡',
      image_file: {
        id: 'local-file-1',
        taskId: 'task-1',
        name: 'portrait.png',
        mimeType: 'image/png',
        previewUrl: '/api/files/local-file-1',
        remoteUrl: 'https://dify.qmniu.com/files/tools/expired.png',
        sourceKind: 'remote'
      },
      status: 'active',
      source: 'manual'
    });

    const context = buildWorkflowRoleContext({
      book_id: 215243,
      role_title: '角色:楚允衡 标题:测试',
      describe: '测试描述',
      chapter_sort: 1
    });

    expect(context.role_url).toBe('http://172.16.79.76:5175/api/files/local-file-1');
  });

  it('uses chapter profile before default profile and only returns active assets', () => {
    const active = createRoleAsset({
      book_id: 1721648,
      novel_name: '第一瞳术师',
      role_name: '云筝',
      image_url: 'https://cdn.example.com/yunzheng.png',
      default_age: '十八岁',
      default_gender: '女',
      default_appearance: '默认外观',
      status: 'active',
      source: 'manual'
    });
    addRoleAssetProfile(active.id, {
      chapter_sort: 12,
      age: '十九岁',
      gender: '女',
      appearance: '章节外观'
    });
    createRoleAsset({
      book_id: 1721648,
      novel_name: '第一瞳术师',
      role_name: '容烁',
      image_url: 'https://cdn.example.com/rongshuo.png',
      status: 'draft',
      source: 'manual'
    });

    const context = buildWorkflowRoleContext({
      book_id: 1721648,
      role_title: '角色:云筝,容烁 标题:双人对峙',
      describe: '双人对峙。',
      chapter_sort: 12
    });

    expect(context.role_list).toEqual(['云筝', '容烁']);
    expect(context.role_url).toBe('https://cdn.example.com/yunzheng.png');
    expect(context.role_have_pic).toBe('云筝');
    expect(context.role_info).toContain('云筝(年龄十九岁,性别女,章节外观)');
    expect(context.prompt).toContain('除云筝外，其余角色请根据文字描述重新生成');
  });

  it('returns no-reference prompt when there is no active base image', () => {
    createRoleAsset({
      book_id: 1721648,
      novel_name: '第一瞳术师',
      role_name: '云筝',
      image_url: 'https://cdn.example.com/yunzheng.png',
      status: 'disabled',
      source: 'manual'
    });

    const context = buildWorkflowRoleContext({
      book_id: 1721648,
      role_title: '角色:云筝 标题:无图生成',
      describe: '只按文字生成。',
      chapter_sort: 1
    });

    expect(context.role_url).toBe('');
    expect(context.role_have_pic).toBe('');
    expect(context.prompt).toContain('无角色参考图');
  });

  it('checks bearer token when ROLE_ASSET_API_TOKEN is configured', () => {
    expect(isRoleAssetTokenAuthorized('Bearer role-token')).toBe(true);
    expect(isRoleAssetTokenAuthorized('Bearer wrong')).toBe(false);
    expect(isRoleAssetTokenAuthorized(undefined)).toBe(false);
  });

  it('maps known character extraction book aliases while importing draft candidates', () => {
    const task: CharacterTask = {
      id: 'character-task-1',
      job_id: 'job-1',
      row_no: 2,
      input: {
        novel_name: '废材又怎么样？照样吊打你！',
        chapter_sort: 1,
        chapter_name: '第1章',
        paragraph_content: '段落',
        paragraph_image_url: 'https://cdn.example.com/scene.png',
        role_name: '月宫宫主'
      },
      status: 'succeeded',
      attempts: 1,
      extracted_description: '白衣，气质清冷',
      portrait_files: [
        {
          id: 'portrait-1',
          taskId: 'character-task-1',
          name: 'portrait.png',
          mimeType: 'image/png',
          previewUrl: '/api/files/portrait-1',
          sourceKind: 'local'
        }
      ]
    };

    const assets = importCharacterTaskToRoleAssets(task);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      book_id: 1721648,
      novel_name: '废材又怎么样？照样吊打你！',
      role_name: '月宫宫主',
      status: 'draft'
    });
  });

  it('exports only requested role assets to Lark with portrait attachment and requested fields', async () => {
    const active = createRoleAsset({
      book_id: 1721648,
      novel_name: '第一瞳术师',
      role_name: '云筝',
      image_file: {
        id: 'role-portrait-1',
        taskId: 'role-task-1',
        name: 'yunzheng.png',
        mimeType: 'image/png',
        previewUrl: '/api/files/role-portrait-1',
        localPath: path.join(os.tmpdir(), 'yunzheng.png'),
        sourceKind: 'local'
      },
      status: 'active',
      source: 'manual'
    });
    createRoleAsset({
      book_id: 215243,
      novel_name: '废材又怎么样？照样吊打你！',
      role_name: '月宫宫主',
      status: 'disabled',
      source: 'manual'
    });

    const larkCalls: Array<{ args: string[]; cwd?: string }> = [];
    const recordPayloads: unknown[] = [];
    const runner: LarkCliRunner = async (args, options) => {
      larkCalls.push({ args, cwd: options?.cwd });
      if (args.includes('+base-create')) {
        const json = { data: { app_token: 'base-token', url: 'https://feishu.example/base/base-token' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+table-create')) {
        const json = { data: { table_id: 'tblRoleAssets' } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      if (args.includes('+record-batch-create')) {
        const jsonArg = args[args.indexOf('--json') + 1];
        const payloadPath = path.join(options?.cwd ?? process.cwd(), jsonArg.replace(/^@\.?\//, ''));
        recordPayloads.push(JSON.parse(await readFile(payloadPath, 'utf8')));
        const json = { data: { record_id_list: ['recRequested'] } };
        return { stdout: JSON.stringify(json), stderr: '', json };
      }
      return { stdout: '{}', stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);

    await withRoleAssetApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/role-assets/export/lark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [active.id] })
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({
        baseUrl: 'https://feishu.example/base/base-token',
        tableName: '角色底图',
        recordsCreated: 1,
        attachmentsUploaded: 1
      });
    });

    const tableCreateCall = larkCalls.find((call) => call.args.includes('+table-create'));
    const tableFields = JSON.parse(tableCreateCall!.args[tableCreateCall!.args.indexOf('--fields') + 1]);
    expect(tableFields.map((field: { name: string }) => field.name)).toEqual(['小说名称', '角色立绘图', '实际提取的角色名称', '启用状态']);
    expect(recordPayloads).toEqual([
      {
        fields: ['小说名称', '实际提取的角色名称', '启用状态'],
        rows: [['第一瞳术师', '云筝', '已启用']]
      }
    ]);
    expect(larkCalls.filter((call) => call.args.includes('+record-upload-attachment')).map((call) => call.args[call.args.indexOf('--field-id') + 1])).toEqual([
      '角色立绘图'
    ]);
  });

  it('rejects empty and unknown role asset export ids without calling Lark', async () => {
    const asset = createRoleAsset({
      book_id: 1721648,
      role_name: '云筝',
      status: 'active',
      source: 'manual'
    });
    const larkCalls: string[][] = [];
    __setLarkCliRunnerForTest(async (args) => {
      larkCalls.push(args);
      return { stdout: '{}', stderr: '' };
    });

    await withRoleAssetApp(async (baseUrl) => {
      const emptyResponse = await fetch(`${baseUrl}/api/role-assets/export/lark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [] })
      });
      expect(emptyResponse.status).toBe(400);

      const unknownResponse = await fetch(`${baseUrl}/api/role-assets/export/lark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [asset.id, 'missing-role-asset'] })
      });
      expect(unknownResponse.status).toBe(400);
      expect(await unknownResponse.json()).toMatchObject({ error: '导出范围包含不存在的角色底图' });
    });

    expect(larkCalls).toHaveLength(0);
  });
});
