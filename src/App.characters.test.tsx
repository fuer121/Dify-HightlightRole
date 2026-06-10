// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

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

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function changeCheckboxValue(input: HTMLInputElement, checked: boolean) {
  if (input.checked !== checked) input.click();
}

describe('App characters page routing', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let characterJobs: unknown[];

  beforeEach(() => {
    window.history.replaceState({}, '', 'http://localhost/?page=characters');
    characterJobs = [];
    class MockEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;

      close() {}
    }
    vi.stubGlobal('EventSource', MockEventSource);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/health')) {
          return jsonResponse({
            config: {
              difyWorkflowName: '主工作流',
              characterDifyWorkflowName: '角色工作流',
              hasCharacterDifyApiKey: true
            }
          });
        }
        if (url.endsWith('/api/character-jobs')) {
          return jsonResponse({ jobs: characterJobs });
        }
        if (url.includes('/api/character-jobs/job-')) {
          const id = url.split('/').pop() ?? 'job-1';
          const summary = characterJobs.find((item) => typeof item === 'object' && item && 'id' in item && item.id === id) as
            | Record<string, unknown>
            | undefined;
          return jsonResponse({
            id,
            workbookId: 'workbook-1',
            fileName: summary?.file_name ?? '角色任务.xlsx',
            sheetName: '执行结果7',
            mapping: {},
            promptText: 'prompt',
            status: summary?.status ?? 'completed',
            createdAt: summary?.created_at ?? '2026-06-09T00:00:00.000Z',
            updatedAt: summary?.updated_at ?? '2026-06-09T00:00:00.000Z',
            tasks: [],
            events: []
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
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

  it('renders the character extraction entry and page from url state', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    expect(container.textContent).toContain('角色形象提取');
    expect(container.textContent).toContain('从角色形象提取开始');
  });

  it('shows only the latest three character history jobs', async () => {
    characterJobs = Array.from({ length: 4 }, (_, index) => ({
      id: `job-${index + 1}`,
      file_name: `角色任务-${index + 1}.xlsx`,
      sheet_name: '执行结果7',
      status: 'completed',
      created_at: `2026-06-09T0${index}:00:00.000Z`,
      updated_at: `2026-06-09T0${index}:00:00.000Z`,
      task_count: 700,
      queued_count: 0,
      running_count: 0,
      succeeded_count: 700,
      failed_count: 0,
      paused_count: 0
    }));

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    expect(container.textContent).toContain('角色任务-1.xlsx');
    expect(container.textContent).toContain('角色任务-2.xlsx');
    expect(container.textContent).toContain('角色任务-3.xlsx');
    expect(container.textContent).not.toContain('角色任务-4.xlsx');
  });

  it('filters character task rows by included role', async () => {
    let startRequestBody: string | null = null;
    let promptPatchBody: string | null = null;
    characterJobs = [
      {
        id: 'job-filter',
        file_name: '角色任务.xlsx',
        sheet_name: '执行结果7',
        status: 'completed',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        task_count: 2,
        queued_count: 0,
        running_count: 0,
        succeeded_count: 1,
        failed_count: 1,
        paused_count: 0
      }
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { characterDifyWorkflowName: '角色工作流', hasCharacterDifyApiKey: true } });
      }
      if (url.endsWith('/api/character-jobs')) return jsonResponse({ jobs: characterJobs });
      if (url.endsWith('/api/character-jobs/job-filter/start')) {
        startRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          id: 'job-filter',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [],
          events: []
        });
      }
      if (url.endsWith('/api/character-jobs/job-filter/prompt')) {
        promptPatchBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          id: 'job-filter',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: JSON.parse(promptPatchBody ?? '{}').promptText,
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [],
          events: []
        });
      }
      if (url.endsWith('/api/character-jobs/job-filter')) {
        return jsonResponse({
          id: 'job-filter',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [
            {
              id: 'task-yz',
              job_id: 'job-filter',
              row_no: 2,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 1,
                chapter_name: '第1章',
                paragraph_content: '云筝出现',
                paragraph_image_url: 'https://cdn.example.com/a.png',
                role_name: '云筝'
              },
              status: 'succeeded',
              attempts: 1,
              portrait_files: []
            },
            {
              id: 'task-rs',
              job_id: 'job-filter',
              row_no: 3,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 2,
                chapter_name: '第2章',
                paragraph_content: '容烁出现',
                paragraph_image_url: 'https://cdn.example.com/b.png',
                role_name: '容烁'
              },
              status: 'failed',
              attempts: 1,
              portrait_files: [],
              error: '失败'
            }
          ],
          events: []
        });
      }
      if (url.endsWith('/api/character-tasks/task-yz/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const input = Array.from(container.querySelectorAll('input')).find((item) => item.getAttribute('placeholder') === '输入角色名')!;
    await act(async () => {
      changeInputValue(input, '云筝');
    });
    await flushUi();

    expect(container.textContent).toContain('云筝');
    expect(container.textContent).not.toContain('容烁出现');

    const promptTextarea = container.querySelector('textarea')!;
    await act(async () => {
      changeTextareaValue(promptTextarea, '新版角色设定图重绘 Prompt');
    });
    await flushUi();

    const startButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('执行提取'))!;
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(JSON.parse(promptPatchBody ?? '{}')).toEqual({ promptText: '新版角色设定图重绘 Prompt' });
    expect(JSON.parse(startRequestBody ?? '{}')).toEqual({ taskIds: ['task-yz'] });
  });

  it('exports only currently filtered character tasks to Lark', async () => {
    let exportRequestBody: string | null = null;
    characterJobs = [
      {
        id: 'job-export',
        file_name: '角色任务.xlsx',
        sheet_name: '执行结果7',
        status: 'completed',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        task_count: 2,
        queued_count: 0,
        running_count: 0,
        succeeded_count: 2,
        failed_count: 0,
        paused_count: 0
      }
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { characterDifyWorkflowName: '角色工作流', hasCharacterDifyApiKey: true } });
      }
      if (url.endsWith('/api/character-jobs')) return jsonResponse({ jobs: characterJobs });
      if (url.endsWith('/api/character-jobs/job-export/export/lark')) {
        exportRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          baseUrl: 'https://feishu.example/base/base-token',
          tableName: '角色立绘结果',
          createdAt: '2026-06-09T00:00:00.000Z',
          recordsCreated: 1,
          attachmentsUploaded: 2
        });
      }
      if (url.endsWith('/api/character-jobs/job-export')) {
        return jsonResponse({
          id: 'job-export',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [
            {
              id: 'task-yz',
              job_id: 'job-export',
              row_no: 2,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 1,
                chapter_name: '第1章',
                paragraph_content: '云筝出现',
                paragraph_image_url: 'https://cdn.example.com/a.png',
                role_name: '云筝'
              },
              status: 'succeeded',
              attempts: 1,
              portrait_files: []
            },
            {
              id: 'task-rs',
              job_id: 'job-export',
              row_no: 3,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 2,
                chapter_name: '第2章',
                paragraph_content: '容烁出现',
                paragraph_image_url: 'https://cdn.example.com/b.png',
                role_name: '容烁'
              },
              status: 'succeeded',
              attempts: 1,
              portrait_files: []
            }
          ],
          events: []
        });
      }
      if (url.endsWith('/api/character-tasks/task-yz/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const input = Array.from(container.querySelectorAll('input')).find((item) => item.getAttribute('placeholder') === '输入角色名')!;
    await act(async () => {
      changeInputValue(input, '云筝');
    });
    await flushUi();

    const exportButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('导出飞书'))!;
    await act(async () => {
      exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushUi();

    expect(JSON.parse(exportRequestBody ?? '{}')).toEqual({ taskIds: ['task-yz'] });
    expect(container.textContent).toContain('飞书 Base：1 行，2 个附件');
  });

  it('excludes multiple selected role candidates from rows and start scope', async () => {
    let startRequestBody: string | null = null;
    characterJobs = [
      {
        id: 'job-exclude',
        file_name: '角色任务.xlsx',
        sheet_name: '执行结果7',
        status: 'completed',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        task_count: 3,
        queued_count: 0,
        running_count: 0,
        succeeded_count: 0,
        failed_count: 3,
        paused_count: 0
      }
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { characterDifyWorkflowName: '角色工作流', hasCharacterDifyApiKey: true } });
      }
      if (url.endsWith('/api/character-jobs')) return jsonResponse({ jobs: characterJobs });
      if (url.endsWith('/api/character-jobs/job-exclude/start')) {
        startRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          id: 'job-exclude',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [],
          events: []
        });
      }
      if (url.endsWith('/api/character-jobs/job-exclude')) {
        return jsonResponse({
          id: 'job-exclude',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [
            {
              id: 'task-yz',
              job_id: 'job-exclude',
              row_no: 2,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 1,
                chapter_name: '第1章',
                paragraph_content: '云筝出现',
                paragraph_image_url: 'https://cdn.example.com/a.png',
                role_name: '云筝'
              },
              status: 'failed',
              attempts: 1,
              portrait_files: []
            },
            {
              id: 'task-rs',
              job_id: 'job-exclude',
              row_no: 3,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 2,
                chapter_name: '第2章',
                paragraph_content: '容烁出现',
                paragraph_image_url: 'https://cdn.example.com/b.png',
                role_name: '容烁,云筝'
              },
              status: 'failed',
              attempts: 1,
              portrait_files: []
            },
            {
              id: 'task-xr',
              job_id: 'job-exclude',
              row_no: 4,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 3,
                chapter_name: '第3章',
                paragraph_content: '萧燃出现',
                paragraph_image_url: 'https://cdn.example.com/c.png',
                role_name: '萧燃'
              },
              status: 'failed',
              attempts: 1,
              portrait_files: []
            }
          ],
          events: []
        });
      }
      if (url.endsWith('/api/character-tasks/task-yz/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const excludeSearchInput = container.querySelector<HTMLInputElement>('input[placeholder="搜索排除角色"]')!;
    await act(async () => {
      changeInputValue(excludeSearchInput, '容');
    });
    await flushUi();

    const rongshuoOption = container.querySelector<HTMLInputElement>('input[aria-label="排除角色 容烁"]')!;
    expect(container.querySelector('.character-role-menu')?.textContent).not.toContain('萧燃');
    await act(async () => {
      changeCheckboxValue(rongshuoOption, true);
    });
    await flushUi();

    await act(async () => {
      changeInputValue(excludeSearchInput, '萧');
    });
    await flushUi();

    const xiaoranOption = container.querySelector<HTMLInputElement>('input[aria-label="排除角色 萧燃"]')!;
    await act(async () => {
      changeCheckboxValue(xiaoranOption, true);
    });
    await flushUi();

    expect(container.textContent).toContain('已排除 2 个');
    expect(container.textContent).toContain('云筝出现');
    expect(container.textContent).not.toContain('容烁出现');
    expect(container.textContent).not.toContain('萧燃出现');

    const startButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('执行提取'))!;
    await act(async () => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(JSON.parse(startRequestBody ?? '{}')).toEqual({ taskIds: ['task-yz'] });
  });

  it('starts only selected character tasks from the batch selection bar', async () => {
    let startRequestBody: string | null = null;
    characterJobs = [
      {
        id: 'job-select',
        file_name: '角色任务.xlsx',
        sheet_name: '执行结果7',
        status: 'completed',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        task_count: 3,
        queued_count: 3,
        running_count: 0,
        succeeded_count: 0,
        failed_count: 0,
        paused_count: 0
      }
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { characterDifyWorkflowName: '角色工作流', hasCharacterDifyApiKey: true } });
      }
      if (url.endsWith('/api/character-jobs')) return jsonResponse({ jobs: characterJobs });
      if (url.endsWith('/api/character-jobs/job-select/start')) {
        startRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          id: 'job-select',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'running',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [],
          events: []
        });
      }
      if (url.endsWith('/api/character-jobs/job-select')) {
        return jsonResponse({
          id: 'job-select',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'completed',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [
            {
              id: 'task-yz',
              job_id: 'job-select',
              row_no: 2,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 1,
                chapter_name: '第1章',
                paragraph_content: '云筝出现',
                paragraph_image_url: 'https://cdn.example.com/a.png',
                role_name: '云筝'
              },
              status: 'queued',
              attempts: 0,
              portrait_files: []
            },
            {
              id: 'task-rs',
              job_id: 'job-select',
              row_no: 3,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 2,
                chapter_name: '第2章',
                paragraph_content: '容烁出现',
                paragraph_image_url: 'https://cdn.example.com/b.png',
                role_name: '容烁'
              },
              status: 'queued',
              attempts: 0,
              portrait_files: []
            },
            {
              id: 'task-xr',
              job_id: 'job-select',
              row_no: 4,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 3,
                chapter_name: '第3章',
                paragraph_content: '萧燃出现',
                paragraph_image_url: 'https://cdn.example.com/c.png',
                role_name: '萧燃'
              },
              status: 'queued',
              attempts: 0,
              portrait_files: []
            }
          ],
          events: []
        });
      }
      if (url.endsWith('/api/character-tasks/task-yz/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const row2Checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择第 2 行"]')!;
    const row4Checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择第 4 行"]')!;
    await act(async () => {
      changeCheckboxValue(row2Checkbox, true);
      changeCheckboxValue(row4Checkbox, true);
    });
    await flushUi();

    const startSelectedButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('执行已选 2 条'))!;
    await act(async () => {
      startSelectedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(JSON.parse(startRequestBody ?? '{}')).toEqual({ taskIds: ['task-yz', 'task-xr'] });
  });

  it('continues all not generated character tasks with explicit task ids', async () => {
    let startRequestBody: string | null = null;
    characterJobs = [
      {
        id: 'job-continue-pending',
        file_name: '角色任务.xlsx',
        sheet_name: '执行结果7',
        status: 'paused',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        task_count: 4,
        queued_count: 1,
        running_count: 0,
        succeeded_count: 1,
        failed_count: 1,
        paused_count: 1
      }
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return jsonResponse({ config: { characterDifyWorkflowName: '角色工作流', hasCharacterDifyApiKey: true } });
      }
      if (url.endsWith('/api/character-jobs')) return jsonResponse({ jobs: characterJobs });
      if (url.endsWith('/api/character-jobs/job-continue-pending/start')) {
        startRequestBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({
          id: 'job-continue-pending',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'running',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [],
          events: []
        });
      }
      if (url.endsWith('/api/character-jobs/job-continue-pending')) {
        return jsonResponse({
          id: 'job-continue-pending',
          workbookId: 'workbook-1',
          fileName: '角色任务.xlsx',
          sheetName: '执行结果7',
          mapping: {},
          promptText: 'prompt',
          status: 'paused',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          tasks: [
            {
              id: 'task-done',
              job_id: 'job-continue-pending',
              row_no: 2,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 1,
                chapter_name: '第1章',
                paragraph_content: '已成功',
                paragraph_image_url: 'https://cdn.example.com/a.png',
                role_name: '云筝'
              },
              status: 'succeeded',
              attempts: 1,
              portrait_files: []
            },
            {
              id: 'task-queued',
              job_id: 'job-continue-pending',
              row_no: 3,
              input: {
                novel_name: '第一瞳术师',
                chapter_sort: 2,
                chapter_name: '第2章',
                paragraph_content: '排队中',
                paragraph_image_url: 'https://cdn.example.com/b.png',
                role_name: '容烁'
              },
              status: 'queued',
              attempts: 0,
              portrait_files: []
            },
            {
              id: 'task-paused',
              job_id: 'job-continue-pending',
              row_no: 4,
              input: {
                novel_name: '废材那又怎样',
                chapter_sort: 3,
                chapter_name: '第3章',
                paragraph_content: '已暂停',
                paragraph_image_url: 'https://cdn.example.com/c.png',
                role_name: '谭浮'
              },
              status: 'paused',
              attempts: 0,
              portrait_files: []
            },
            {
              id: 'task-failed',
              job_id: 'job-continue-pending',
              row_no: 5,
              input: {
                novel_name: '废材那又怎样',
                chapter_sort: 4,
                chapter_name: '第4章',
                paragraph_content: '失败',
                paragraph_image_url: 'https://cdn.example.com/d.png',
                role_name: '陆征'
              },
              status: 'failed',
              attempts: 1,
              portrait_files: []
            }
          ],
          events: []
        });
      }
      if (url.endsWith('/api/character-tasks/task-done/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushUi();

    const continueAllButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('继续全部未生成'))!;
    await act(async () => {
      continueAllButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(JSON.parse(startRequestBody ?? '{}')).toEqual({ taskIds: ['task-queued', 'task-paused'] });
  });
});
