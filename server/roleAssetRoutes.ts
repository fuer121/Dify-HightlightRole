import express from 'express';
import multer from 'multer';
import { getCharacterTaskById } from './characterStore.js';
import { registerBufferFile } from './fileStore.js';
import { exportRoleAssetsToLark } from './lark.js';
import type { RoleAssetStatus } from './types.js';
import {
  addRoleAssetProfile,
  backfillCharacterRoleAssets,
  buildWorkflowRoleContext,
  createRoleAsset,
  deleteRoleAsset,
  deleteRoleAssetProfile,
  getRoleAsset,
  importCharacterTaskPayload,
  isRoleAssetTokenAuthorized,
  listRoleAssets,
  updateRoleAsset,
  updateRoleAssetProfile
} from './roleAssets.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

function asyncHandler<TReq extends express.Request, TRes extends express.Response>(
  handler: (req: TReq, res: TRes) => Promise<void>
) {
  return (req: TReq, res: TRes, next: express.NextFunction) => {
    handler(req, res).catch(next);
  };
}

function numberValue(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} 必须是数字`);
  return number;
}

function optionalNumberValue(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringPatchValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value ?? '';
}

function statusValue(value: unknown): RoleAssetStatus | undefined {
  return value === 'draft' || value === 'active' || value === 'disabled' ? value : undefined;
}

async function uploadedImage(req: express.Request) {
  const file = req.file;
  if (!file) return undefined;
  return registerBufferFile('role-asset', file.buffer, file.originalname, file.mimetype);
}

export function registerRoleAssetRoutes(app: express.Express) {
  app.get('/api/role-assets', (req, res) => {
    res.json({
      assets: listRoleAssets({
        bookId: optionalNumberValue(req.query.bookId),
        q: stringValue(req.query.q),
        status: statusValue(req.query.status) ?? (req.query.status === 'all' ? 'all' : undefined),
        hasImage: req.query.hasImage === 'yes' || req.query.hasImage === 'no' ? req.query.hasImage : 'all',
        hasProfile: req.query.hasProfile === 'yes' || req.query.hasProfile === 'no' ? req.query.hasProfile : 'all'
      })
    });
  });

  app.post(
    '/api/role-assets',
    upload.single('image'),
    asyncHandler(async (req, res) => {
      const imageFile = await uploadedImage(req);
      const asset = createRoleAsset({
        book_id: numberValue(req.body.book_id, 'book_id'),
        novel_name: stringValue(req.body.novel_name),
        role_name: stringValue(req.body.role_name) ?? '',
        image_file: imageFile,
        image_url: stringValue(req.body.image_url),
        default_age: stringValue(req.body.default_age),
        default_gender: stringValue(req.body.default_gender),
        default_appearance: stringValue(req.body.default_appearance),
        note: stringValue(req.body.note),
        status: statusValue(req.body.status) ?? 'draft',
        source: 'manual'
      });
      if (!asset.role_name) {
        throw new Error('角色名不能为空');
      }
      res.status(201).json({ asset });
    })
  );

  app.patch(
    '/api/role-assets/:id',
    upload.single('image'),
    asyncHandler(async (req, res) => {
      const imageFile = await uploadedImage(req);
      const asset = updateRoleAsset(routeParam(req.params.id), {
        book_id: optionalNumberValue(req.body.book_id),
        novel_name: stringPatchValue(req.body.novel_name),
        role_name: stringValue(req.body.role_name),
        image_file: imageFile,
        image_url: stringPatchValue(req.body.image_url),
        default_age: stringPatchValue(req.body.default_age),
        default_gender: stringPatchValue(req.body.default_gender),
        default_appearance: stringPatchValue(req.body.default_appearance),
        note: stringPatchValue(req.body.note),
        status: statusValue(req.body.status)
      });
      if (!asset) {
        res.status(404).json({ error: '角色底图不存在' });
        return;
      }
      res.json({ asset });
    })
  );

  app.delete('/api/role-assets/:id', (req, res) => {
    if (!deleteRoleAsset(routeParam(req.params.id))) {
      res.status(404).json({ error: '角色底图不存在' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/role-assets/import-character-task', (req, res) => {
    const taskId = stringValue(req.body.task_id);
    if (!taskId) throw new Error('task_id 不能为空');
    const task = getCharacterTaskById(taskId);
    if (!task) {
      res.status(404).json({ error: '角色任务不存在' });
      return;
    }
    const assets = importCharacterTaskPayload({
      task,
      book_id: optionalNumberValue(req.body.book_id),
      role_name: stringValue(req.body.role_name),
      image_url: stringValue(req.body.image_url),
      status: statusValue(req.body.status) ?? 'draft'
    });
    res.status(201).json({ assets });
  });

  app.post('/api/role-assets/backfill-character-tasks', (_req, res) => {
    res.json({ result: backfillCharacterRoleAssets() });
  });

  app.post(
    '/api/role-assets/export/lark',
    asyncHandler(async (req, res) => {
      const { assetIds } = req.body as { assetIds?: unknown };
      if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.some((assetId) => typeof assetId !== 'string')) {
        res.status(400).json({ error: 'assetIds 必须是非空字符串数组' });
        return;
      }

      const requestedIds = Array.from(new Set(assetIds));
      const assets = requestedIds.map((assetId) => getRoleAsset(assetId));
      if (assets.some((asset) => !asset)) {
        res.status(400).json({ error: '导出范围包含不存在的角色底图' });
        return;
      }

      const exportAssets = assets.filter((asset): asset is NonNullable<(typeof assets)[number]> => asset !== undefined);
      const result = await exportRoleAssetsToLark(exportAssets);
      res.json(result);
    })
  );

  app.get('/api/role-assets/:id/profiles', (req, res) => {
    const asset = getRoleAsset(routeParam(req.params.id));
    if (!asset) {
      res.status(404).json({ error: '角色底图不存在' });
      return;
    }
    res.json({ profiles: asset.profiles ?? [] });
  });

  app.post('/api/role-assets/:id/profiles', (req, res) => {
    const profile = addRoleAssetProfile(routeParam(req.params.id), {
      chapter_sort: numberValue(req.body.chapter_sort, 'chapter_sort'),
      age: stringValue(req.body.age),
      gender: stringValue(req.body.gender),
      appearance: stringValue(req.body.appearance)
    });
    res.status(201).json({ profile });
  });

  app.patch('/api/role-assets/:id/profiles/:profileId', (req, res) => {
    const profile = updateRoleAssetProfile(routeParam(req.params.profileId), {
      chapter_sort: optionalNumberValue(req.body.chapter_sort),
      age: stringPatchValue(req.body.age),
      gender: stringPatchValue(req.body.gender),
      appearance: stringPatchValue(req.body.appearance)
    });
    if (!profile) {
      res.status(404).json({ error: '章节画像不存在' });
      return;
    }
    res.json({ profile });
  });

  app.delete('/api/role-assets/:id/profiles/:profileId', (req, res) => {
    if (!deleteRoleAssetProfile(routeParam(req.params.profileId))) {
      res.status(404).json({ error: '章节画像不存在' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/workflow/role-context', (req, res) => {
    if (!isRoleAssetTokenAuthorized(req.header('authorization'))) {
      res.status(401).json({ error: 'ROLE_ASSET_API_TOKEN 无效' });
      return;
    }
    res.json(
      buildWorkflowRoleContext({
        book_id: numberValue(req.body.book_id, 'book_id'),
        role_title: stringValue(req.body.role_title) ?? '',
        describe: stringValue(req.body.describe) ?? '',
        chapter_sort: numberValue(req.body.chapter_sort, 'chapter_sort')
      })
    );
  });
}
