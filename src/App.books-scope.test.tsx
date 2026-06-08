// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

class MockEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {}

  close() {}
}

const booksPayload = {
  books: [
    {
      book_id: 1,
      name: '测试书籍',
      task_count: 2,
      queued_count: 1,
      running_count: 0,
      succeeded_count: 1,
      failed_count: 0,
      paused_count: 0,
      unfinished_count: 1,
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z'
    }
  ]
};

const batchesPayload = {
  batches: [
    {
      id: 'batch-1',
      file_name: '导入批次一',
      sheet_name: 'Sheet1',
      status: 'idle',
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      task_count: 2,
      queued_count: 1,
      running_count: 0,
      succeeded_count: 1,
      failed_count: 0,
      paused_count: 0,
      unfinished_count: 1
    },
    {
      id: 'batch-2',
      file_name: '导入批次二',
      sheet_name: 'Sheet2',
      status: 'idle',
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      task_count: 1,
      queued_count: 1,
      running_count: 0,
      succeeded_count: 0,
      failed_count: 0,
      paused_count: 0,
      unfinished_count: 1
    }
  ]
};

const tasksPayload = {
  tasks: [
    {
      id: 'task-1',
      row_no: 2,
      input: { book_id: 1, paragraph_content: '第一段', chapter_sort: 1 },
      status: 'queued',
      attempts: 0,
      result_files: []
    },
    {
      id: 'task-2',
      row_no: 3,
      input: { book_id: 1, paragraph_content: '第二段', chapter_sort: 2 },
      status: 'succeeded',
      attempts: 1,
      result_files: []
    }
  ],
  pagination: {
    page: 1,
    pageSize: 50,
    total: 2,
    totalPages: 1,
    runnableTotal: 2
  }
};

const continuePayload = {
  id: 'batch-1',
  workbookId: 'workbook-1',
  sheetName: 'Sheet1',
  fileName: '导入批次一',
  mapping: {
    book_id: 'book_id',
    paragraph_content: 'paragraph_content',
    chapter_sort: 'chapter_sort'
  },
  status: 'idle',
  createdAt: '2026-06-07T00:00:00.000Z',
  updatedAt: '2026-06-07T00:00:00.000Z',
  pauseRequested: false,
  tasks: tasksPayload.tasks,
  events: []
};

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

function findButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`未找到按钮: ${text}`);
  }
  return button;
}

function findSelectByLabel(container: HTMLElement, text: string) {
  const label = Array.from(container.querySelectorAll('label')).find((node) => node.textContent?.includes(text));
  const select = label?.querySelector('select');
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`未找到下拉框: ${text}`);
  }
  return select;
}

function findLastCallUrl(fetchSpy: ReturnType<typeof vi.fn>, pattern: string) {
  return fetchSpy.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes(pattern))
    .at(-1);
}

function getTaskSummaryText(container: HTMLElement) {
  const summary = Array.from(container.querySelectorAll('span')).find((node) =>
    node.textContent?.includes('当前页')
  );
  if (!summary?.textContent) {
    throw new Error('未找到任务列表摘要');
  }
  return summary.textContent.replace(/\s+/g, ' ').trim();
}

function findInputByLabel(container: HTMLElement, text: string) {
  const label = Array.from(container.querySelectorAll('label')).find((node) => node.textContent?.includes(text));
  const input = label?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`未找到输入框: ${text}`);
  }
  return input;
}

describe('BooksManagementPage continue scope', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/api/health')) return jsonResponse({ config: { difyWorkflowName: '测试工作流' } });
      if (url.endsWith('/api/books')) return jsonResponse(booksPayload);
      if (url.endsWith('/api/books/1/batches')) return jsonResponse(batchesPayload);
      if (url.includes('/api/books/1/tasks')) return jsonResponse(tasksPayload);
      if (url.endsWith('/api/tasks/task-1/runs')) return jsonResponse({ runs: [] });
      if (url.endsWith('/api/tasks/task-2/runs')) return jsonResponse({ runs: [] });
      if (url.includes('/api/books/1/continue')) return jsonResponse(continuePayload);

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('continues with the last applied query instead of unsaved filter drafts', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    const statusSelect = findSelectByLabel(container, '任务状态');
    await act(async () => {
      statusSelect.value = 'succeeded';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    await act(async () => {
      findButton(container, '执行生图').click();
    });
    await flushUi();

    const continueWithoutQuery = fetchSpy.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('/api/books/1/continue'));
    expect(continueWithoutQuery).toBe('/api/books/1/continue?batchId=batch-1');

    await act(async () => {
      findButton(container, '查询').click();
    });
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '执行生图').click();
    });
    await flushUi();

    const continueCalls = fetchSpy.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/api/books/1/continue'));
    expect(continueCalls.at(-1)).toBe('/api/books/1/continue?status=succeeded&batchId=batch-1');
  });

  it('keeps automatic reloads on the applied scope after continue succeeds', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    const statusSelect = findSelectByLabel(container, '任务状态');
    await act(async () => {
      statusSelect.value = 'succeeded';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, '查询').click();
    });
    await flushUi();
    await flushUi();

    await act(async () => {
      statusSelect.value = 'queued';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    await act(async () => {
      findButton(container, '执行生图').click();
    });
    await flushUi();
    await flushUi();
    await flushUi();

    expect(findLastCallUrl(fetchSpy, '/api/books/1/continue')).toBe('/api/books/1/continue?status=succeeded&batchId=batch-1');
    expect(findLastCallUrl(fetchSpy, '/api/books/1/tasks')).toContain('/api/books/1/tasks?status=succeeded&batchId=batch-1&page=1&pageSize=');

    await act(async () => {
      findButton(container, '执行生图').click();
    });
    await flushUi();

    const continueCalls = fetchSpy.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/api/books/1/continue'));
    expect(continueCalls.at(-1)).toBe('/api/books/1/continue?status=succeeded&batchId=batch-1');
  });

  it('loads a switched batch with its own saved scope instead of the previous render draft', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    const statusSelect = findSelectByLabel(container, '任务状态');
    await act(async () => {
      statusSelect.value = 'succeeded';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, '查询').click();
    });
    await flushUi();
    await flushUi();

    await act(async () => {
      statusSelect.value = 'queued';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次二').click();
    });
    await flushUi();
    await flushUi();

    expect(findLastCallUrl(fetchSpy, '/api/books/1/tasks')).toContain('/api/books/1/tasks?batchId=batch-2&page=1&pageSize=');

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    expect(findLastCallUrl(fetchSpy, '/api/books/1/tasks')).toContain('/api/books/1/tasks?status=succeeded&batchId=batch-1&page=1&pageSize=');
  });

  it('keeps the current list summary and continue button state on the applied scope until search is clicked', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    const statusSelect = findSelectByLabel(container, '任务状态');
    await act(async () => {
      statusSelect.value = 'succeeded';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, '查询').click();
    });
    await flushUi();
    await flushUi();

    expect(getTaskSummaryText(container)).toContain('当前页 2 条 / 共 2 条 · 可执行 2 条');
    const continueButton = findButton(container, '执行生图');
    expect(continueButton.disabled).toBe(false);
    expect(continueButton.title).toContain('状态 成功');

    await act(async () => {
      statusSelect.value = 'queued';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    expect(getTaskSummaryText(container)).toContain('当前页 2 条 / 共 2 条 · 可执行 2 条');
    expect(continueButton.disabled).toBe(false);
    expect(continueButton.title).toContain('状态 成功');
    expect(findLastCallUrl(fetchSpy, '/api/books/1/tasks')).toContain('/api/books/1/tasks?status=succeeded&batchId=batch-1&page=1&pageSize=');
  });

  it('does not implicitly refresh tasks or apply unsaved drafts when pressing Enter in the range popover', async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    await act(async () => {
      findButton(container, '导入批次一').click();
    });
    await flushUi();
    await flushUi();

    const statusSelect = findSelectByLabel(container, '任务状态');
    await act(async () => {
      statusSelect.value = 'succeeded';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      findButton(container, '查询').click();
    });
    await flushUi();
    await flushUi();

    const taskCallsBeforeDraft = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/books/1/tasks')).length;

    await act(async () => {
      statusSelect.value = 'queued';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    await act(async () => {
      findButton(container, '范围').click();
    });
    await flushUi();

    const rowModeSelect = findSelectByLabel(container, '筛选维度');
    await act(async () => {
      rowModeSelect.value = 'row';
      rowModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    const rowFromInput = findInputByLabel(container, '行数从');
    await act(async () => {
      rowFromInput.value = '3';
      rowFromInput.dispatchEvent(new Event('input', { bubbles: true }));
      rowFromInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushUi();

    await act(async () => {
      rowFromInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flushUi();
    await flushUi();

    const taskCallsAfterEnter = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/books/1/tasks')).length;
    expect(taskCallsAfterEnter).toBe(taskCallsBeforeDraft);
    expect(findLastCallUrl(fetchSpy, '/api/books/1/tasks')).toContain('/api/books/1/tasks?status=succeeded&batchId=batch-1&page=1&pageSize=');
    expect(getTaskSummaryText(container)).toContain('当前页 2 条 / 共 2 条 · 可执行 2 条');
    expect(findButton(container, '执行生图').title).toContain('状态 成功');
  });
});
