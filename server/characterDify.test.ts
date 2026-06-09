import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterTask } from './types.js';
import { runCharacterWorkflow } from './characterDify.js';

const task: CharacterTask = {
  id: 'character-task-network',
  job_id: 'character-job-network',
  row_no: 2,
  input: {
    novel_name: '小说',
    chapter_sort: 1,
    chapter_name: '章节',
    paragraph_content: '段落',
    paragraph_image_url: 'https://cdn.example.com/a.png',
    role_name: '云筝'
  },
  status: 'running',
  attempts: 1,
  portrait_files: []
};

describe('character Dify workflow', () => {
  afterEach(() => {
    delete process.env.CHARACTER_DIFY_API_BASE;
    delete process.env.CHARACTER_DIFY_API_KEY;
    delete process.env.CHARACTER_DIFY_RESPONSE_MODE;
  });

  it('includes network failure details when Dify fetch fails', async () => {
    process.env.CHARACTER_DIFY_API_BASE = 'http://127.0.0.1:65535';
    process.env.CHARACTER_DIFY_API_KEY = 'test-key';
    process.env.CHARACTER_DIFY_RESPONSE_MODE = 'blocking';

    await expect(runCharacterWorkflow(task, 'prompt', 'job-1')).rejects.toThrow(/角色形象提取请求失败：fetch failed.*ECONNREFUSED/);
  });
});
