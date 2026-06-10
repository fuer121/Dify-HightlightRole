// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/?page=role-assets"}

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

const allAssets = [
  {
    id: 'asset-1',
    book_id: 1721648,
    novel_name: '第一瞳术师',
    role_name: '云筝',
    image_url: 'https://cdn.example.com/yunzheng.png',
    default_appearance: '红衣少女',
    status: 'active',
    source: 'manual',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    profiles: []
  },
  {
    id: 'asset-2',
    book_id: 215243,
    novel_name: '废材又怎么样？照样吊打你！',
    role_name: '月宫宫主',
    status: 'disabled',
    source: 'manual',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    profiles: []
  }
];

async function flushUi() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`找不到按钮：${text}`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App role assets page routing', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    window.history.replaceState({}, '', 'http://localhost/?page=role-assets');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return jsonResponse({ config: { difyWorkflowName: '主工作流' } });
        }
        if (url.startsWith('/api/role-assets')) {
          return jsonResponse({ assets: allAssets.slice(0, 1) });
        }
        return jsonResponse({});
      })
    );
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens role asset management from page query', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    expect(container.textContent).toContain('角色底图管理');
    expect(container.textContent).toContain('筛选角色底图');
    expect(container.textContent).toContain('云筝');
  });

  it('exports the current filtered role asset ids to Lark', async () => {
    let exportRequestBody: string | null = null;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { difyWorkflowName: '主工作流' } });
      }
      if (url.endsWith('/api/role-assets/export/lark')) {
        exportRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          baseUrl: 'https://feishu.example/base/base-token',
          tableName: '角色底图',
          createdAt: '2026-06-09T00:00:00.000Z',
          recordsCreated: 1,
          attachmentsUploaded: 1
        });
      }
      if (url.includes('/api/role-assets?') && url.includes('q=%E6%9C%88')) {
        return jsonResponse({ assets: [allAssets[1]] });
      }
      if (url.startsWith('/api/role-assets')) {
        return jsonResponse({ assets: allAssets });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const keywordInput = Array.from(container.querySelectorAll('input')).find((input) => input.placeholder === '输入关键词');
    expect(keywordInput).toBeTruthy();
    await act(async () => {
      changeInput(keywordInput!, '月');
    });
    await act(async () => {
      clickButton(container, '查询');
    });
    await flushUi();
    expect(container.textContent).toContain('月宫宫主');

    await act(async () => {
      clickButton(container, '导出飞书');
    });
    await flushUi();

    expect(exportRequestBody).toBe(JSON.stringify({ assetIds: ['asset-2'] }));
    expect(container.textContent).toContain('飞书 Base');
    expect(container.textContent).toContain('已导出 1 行');
    expect(container.textContent).toContain('上传附件 1 个');
  });
});
