import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { nanoid } from 'nanoid';
import type { ResultFile } from './types.js';

const TMP_DIR = path.resolve(process.cwd(), 'tmp', 'dify-files');

export class FileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileUnavailableError';
  }
}

const files = new Map<string, ResultFile>();

function extensionForMime(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

function sniffImageMime(buffer: Buffer, fallback: string) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return fallback;
}

function guessMimeFromName(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function resolveDifyUrl(remoteUrl: string) {
  if (/^https?:\/\//i.test(remoteUrl)) return remoteUrl;
  const base = process.env.DIFY_API_BASE ?? '';
  if (!base) return remoteUrl;
  return new URL(remoteUrl, base.endsWith('/') ? base : `${base}/`).toString();
}

function candidateUrls(remoteUrl: string) {
  const candidates = new Set<string>();
  if (/^https?:\/\//i.test(remoteUrl)) {
    candidates.add(remoteUrl);
    return Array.from(candidates);
  }

  const apiBaseRaw = process.env.DIFY_API_BASE ?? '';
  if (apiBaseRaw) {
    const apiBase = apiBaseRaw.endsWith('/') ? apiBaseRaw : `${apiBaseRaw}/`;
    candidates.add(new URL(remoteUrl, apiBase).toString());
    if (remoteUrl.startsWith('/')) {
      candidates.add(`${apiBase.replace(/\/$/, '')}${remoteUrl}`);
    }

    try {
      const parsed = new URL(apiBaseRaw);
      candidates.add(new URL(remoteUrl, `${parsed.origin}/`).toString());
    } catch {
      // Ignore malformed env values; the plain relative URL is kept below.
    }
  }

  candidates.add(remoteUrl);
  return Array.from(candidates);
}

function authHeadersFor(url: string) {
  const key = process.env.DIFY_API_KEY;
  if (!key) return {};
  try {
    const apiBase = new URL(process.env.DIFY_API_BASE ?? '');
    const target = new URL(url);
    if (apiBase.host === target.host) {
      return { Authorization: `Bearer ${key}` };
    }
  } catch {
    return {};
  }
  return {};
}

export function registerRemoteFile(taskId: string, remoteUrl: string, name?: string, mimeType?: string) {
  const id = nanoid();
  const remoteUrls = candidateUrls(remoteUrl);
  const resolved = remoteUrls[0] ?? resolveDifyUrl(remoteUrl);
  const safeName = name || `dify-result-${id}.${extensionForMime(mimeType ?? guessMimeFromName(remoteUrl))}`;
  const file: ResultFile = {
    id,
    taskId,
    name: safeName,
    mimeType: mimeType ?? guessMimeFromName(safeName),
    previewUrl: `/api/files/${id}`,
    remoteUrl: resolved,
    remoteUrls,
    sourceKind: 'remote'
  };
  files.set(id, file);
  return file;
}

export async function registerBase64File(taskId: string, value: string, name?: string) {
  const id = nanoid();
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  const base64 = match?.[2] ?? value;
  const buffer = Buffer.from(base64, 'base64');
  const mimeType = sniffImageMime(buffer, match?.[1] ?? 'image/png');
  const fileName = name || `dify-result-${id}.${extensionForMime(mimeType)}`;
  await mkdir(TMP_DIR, { recursive: true });
  const localPath = path.join(TMP_DIR, fileName);
  await writeFile(localPath, buffer);
  const file: ResultFile = {
    id,
    taskId,
    name: fileName,
    mimeType,
    size: buffer.length,
    previewUrl: `/api/files/${id}`,
    localPath,
    sourceKind: 'base64'
  };
  files.set(id, file);
  return file;
}

export function getFile(id: string) {
  return files.get(id);
}

export function registerStoredFile(file: ResultFile) {
  files.set(file.id, file);
}

export async function ensureLocalFile(file: ResultFile) {
  if (file.localPath) return file.localPath;
  const remoteUrls = file.remoteUrls?.length ? file.remoteUrls : file.remoteUrl ? [file.remoteUrl] : [];
  if (remoteUrls.length === 0) {
    throw new Error(`文件 ${file.name} 没有可下载地址`);
  }

  await mkdir(TMP_DIR, { recursive: true });
  const ext = path.extname(file.name) || `.${extensionForMime(file.mimeType)}`;
  const localPath = path.join(TMP_DIR, `${file.id}${ext}`);
  const errors: string[] = [];
  for (const url of remoteUrls) {
    try {
      const response = await fetch(url, {
        headers: authHeadersFor(url),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        errors.push(`${response.status} ${url}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      file.mimeType = sniffImageMime(buffer, file.mimeType);
      await writeFile(localPath, buffer);
      file.localPath = localPath;
      file.remoteUrl = url;
      file.size = buffer.length;
      files.set(file.id, file);
      return localPath;
    } catch (error) {
      errors.push(`${error instanceof Error ? error.message : '请求失败'} ${url}`);
    }
  }
  throw new Error(`下载图片失败：${errors.join('；')}`);
}

export async function streamFile(id: string) {
  const file = getFile(id);
  if (!file) {
    return undefined;
  }

  if (file.localPath) {
    return {
      file,
      stream: createReadStream(file.localPath),
      size: (await stat(file.localPath)).size
    };
  }

  try {
    await ensureLocalFile(file);
  } catch {
    // Fall through to live proxy attempts below so callers get the latest failure detail.
  }

  if (file.localPath) {
    return {
      file,
      stream: createReadStream(file.localPath),
      size: (await stat(file.localPath)).size
    };
  }

  const remoteUrls = file.remoteUrls?.length ? file.remoteUrls : file.remoteUrl ? [file.remoteUrl] : [];
  if (remoteUrls.length === 0) {
    return undefined;
  }

  const errors: string[] = [];
  for (const url of remoteUrls) {
    try {
      const response = await fetch(url, {
        headers: authHeadersFor(url),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok || !response.body) {
        errors.push(`${response.status} ${url}`);
        continue;
      }
      file.remoteUrl = url;
      files.set(file.id, file);
      return {
        file,
        stream: Readable.fromWeb(response.body),
        size: Number(response.headers.get('content-length') ?? 0) || undefined
      };
    } catch (error) {
      errors.push(`${error instanceof Error ? error.message : '请求失败'} ${url}`);
    }
  }
  throw new FileUnavailableError(`图片链接已失效或暂时不可访问：${errors.join('；')}`);
}
