import { describe, expect, it } from 'vitest';
import { __qualityTestables } from './quality.js';

describe('quality helpers', () => {
  it('extracts deployable prompt from skill markdown fences', () => {
    expect(__qualityTestables.promptFromMarkdown('# Production Prompt\n\n```text\nhello\n```\n')).toBe('hello');
    expect(__qualityTestables.promptFromMarkdown('plain prompt')).toBe('plain prompt');
  });

  it('normalizes list-like model outputs', () => {
    expect(__qualityTestables.toStringArray('红衣、断剑，暴雨')).toEqual(['红衣', '断剑', '暴雨']);
    expect(__qualityTestables.toStringArray('无')).toEqual([]);
    expect(__qualityTestables.toStringArray(['山门', '  ', '火光'])).toEqual(['山门', '火光']);
  });

  it('inserts calibration rules before output requirements when possible', () => {
    const next = __qualityTestables.appendCalibrationPrompt('角色设定\n\n输出要求\n只输出 JSON', '新增规则');
    expect(next.indexOf('新增规则')).toBeLessThan(next.indexOf('输出要求'));
  });
});
