// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/?page=workflows"}

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

async function flushUi() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function changeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App workflow management page', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let patchBody: string | null;
  let workflowGroupsResponse: unknown;

  beforeEach(() => {
    window.history.replaceState({}, '', 'http://localhost/?page=workflows');
    patchBody = null;
    workflowGroupsResponse = {
      groups: [
        {
          id: 'default',
          name: '默认分组',
          status: 'active',
          is_default: true,
          note: '默认双工作流',
          created_at: '2026-06-10T00:00:00.000Z',
          updated_at: '2026-06-10T00:00:00.000Z',
          workflows: [
            {
              id: 'primary',
              group_id: 'default',
              name: '线上工作流',
              api_key: 'app-primary-visible',
              console_url: 'https://dify.example/primary',
              note: '主链路',
              created_at: '2026-06-10T00:00:00.000Z',
              updated_at: '2026-06-10T00:00:00.000Z'
            },
            {
              id: 'compare',
              group_id: 'default',
              name: '对照工作流',
              api_key: 'app-compare-visible',
              console_url: '',
              note: '',
              created_at: '2026-06-10T00:00:00.000Z',
              updated_at: '2026-06-10T00:00:00.000Z'
            }
          ]
        }
      ]
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return jsonResponse({
            config: {
              difyWorkflows: [
                { id: 'primary', name: '环境主工作流', configured: true, responseMode: 'streaming' },
                { id: 'compare', name: '环境对照工作流', configured: true, responseMode: 'streaming' }
              ]
            }
          });
        }
        if (url.endsWith('/api/workflow-groups')) {
          return jsonResponse(workflowGroupsResponse);
        }
        if (url.endsWith('/api/workflow-groups/default/workflows/primary')) {
          patchBody = typeof init?.body === 'string' ? init.body : null;
          const updatedGroup = {
            id: 'default',
            name: '默认分组',
            status: 'active',
            is_default: true,
            note: '默认双工作流',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T01:00:00.000Z',
            workflows: [
              {
                id: 'primary',
                group_id: 'default',
                name: '新版主工作流',
                api_key: 'app-primary-updated',
                console_url: 'https://dify.example/new-primary',
                note: '更新备注',
                created_at: '2026-06-10T00:00:00.000Z',
                updated_at: '2026-06-10T01:00:00.000Z'
              },
              {
                id: 'compare',
                group_id: 'default',
                name: '对照工作流',
                api_key: 'app-compare-visible',
                console_url: '',
                note: '',
                created_at: '2026-06-10T00:00:00.000Z',
                updated_at: '2026-06-10T00:00:00.000Z'
              }
            ]
          };
          workflowGroupsResponse = { groups: [updatedGroup] };
          return jsonResponse({ group: updatedGroup });
        }
        return jsonResponse({});
      })
    );
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens workflow management from page query and shows api keys in plain text', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    expect(container.textContent).toContain('Workflow 管理');
    expect(container.textContent).toContain('书籍库 Workflow 分组');
    expect(container.textContent).toContain('默认分组');
    expect(container.textContent).toContain('主工作流');
    expect((Array.from(container.querySelectorAll('input')).find((input) => input.value === 'app-primary-visible') as HTMLInputElement | undefined)?.value).toBe(
      'app-primary-visible'
    );
  });

  it('saves primary workflow config and refreshes sidebar workflow names', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const inputs = Array.from(container.querySelectorAll('input'));
    const textareas = Array.from(container.querySelectorAll('textarea'));
    changeInputValue(inputs.find((input) => input.value === '线上工作流')!, '新版主工作流');
    changeInputValue(inputs.find((input) => input.value === 'app-primary-visible')!, 'app-primary-updated');
    changeInputValue(inputs.find((input) => input.value === 'https://dify.example/primary')!, 'https://dify.example/new-primary');
    changeInputValue(textareas.find((textarea) => textarea.value === '主链路')!, '更新备注');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('保存配置'))!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUi();

    expect(JSON.parse(patchBody ?? '{}')).toEqual({
      name: '新版主工作流',
      api_key: 'app-primary-updated',
      console_url: 'https://dify.example/new-primary',
      note: '更新备注'
    });
    expect(container.textContent).toContain('默认分组 / 主工作流 已保存');
    expect(container.textContent).toContain('新版主工作流 / 对照工作流');
  });
});
