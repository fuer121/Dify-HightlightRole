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
  let healthCalls: number;

  beforeEach(() => {
    window.history.replaceState({}, '', 'http://localhost/?page=workflows');
    patchBody = null;
    healthCalls = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          healthCalls += 1;
          return jsonResponse({
            config: {
              difyWorkflows:
                healthCalls > 1
                  ? [
                      { id: 'primary', name: '新版主工作流', configured: true, responseMode: 'streaming' },
                      { id: 'compare', name: '对照工作流', configured: true, responseMode: 'streaming' }
                    ]
                  : [
                      { id: 'primary', name: '线上工作流', configured: true, responseMode: 'streaming' },
                      { id: 'compare', name: '对照工作流', configured: true, responseMode: 'streaming' }
                    ]
            }
          });
        }
        if (url.endsWith('/api/workflows')) {
          return jsonResponse({
            workflows: [
              {
                id: 'primary',
                name: '线上工作流',
                api_key: 'app-primary-visible',
                console_url: 'https://dify.example/primary',
                note: '主链路',
                created_at: '2026-06-10T00:00:00.000Z',
                updated_at: '2026-06-10T00:00:00.000Z'
              },
              {
                id: 'compare',
                name: '对照工作流',
                api_key: 'app-compare-visible',
                console_url: '',
                note: '',
                created_at: '2026-06-10T00:00:00.000Z',
                updated_at: '2026-06-10T00:00:00.000Z'
              }
            ]
          });
        }
        if (url.endsWith('/api/workflows/primary')) {
          patchBody = typeof init?.body === 'string' ? init.body : null;
          return jsonResponse({
            workflow: {
              id: 'primary',
              name: '新版主工作流',
              api_key: 'app-primary-updated',
              console_url: 'https://dify.example/new-primary',
              note: '更新备注',
              created_at: '2026-06-10T00:00:00.000Z',
              updated_at: '2026-06-10T01:00:00.000Z'
            }
          });
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
    expect(container.textContent).toContain('书籍库双工作流配置');
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
    changeInputValue(inputs[0], '新版主工作流');
    changeInputValue(inputs[1], 'app-primary-updated');
    changeInputValue(inputs[2], 'https://dify.example/new-primary');
    changeInputValue(textareas[0], '更新备注');

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
    expect(container.textContent).toContain('主工作流已保存');
    expect(container.textContent).toContain('新版主工作流 / 对照工作流');
  });
});
