import { describe, expect, it } from 'vitest';
import { getRunIsValidValue } from './runIsValid';

describe('getRunIsValidValue', () => {
  it('prefers the run-level is_valid field', () => {
    expect(
      getRunIsValidValue({
        id: 'run-1',
        task_id: 'task-1',
        attempt_no: 2,
        status: 'succeeded',
        result_files: [],
        is_valid: 0,
        raw_outputs: { is_valid: 1 },
        created_at: '2026-06-08T00:00:00.000Z'
      })
    ).toBe(0);
  });

  it('falls back to raw_outputs.is_valid for legacy runs', () => {
    expect(
      getRunIsValidValue({
        id: 'run-legacy',
        task_id: 'task-1',
        attempt_no: 1,
        status: 'succeeded',
        result_files: [],
        raw_outputs: { is_valid: '1' },
        created_at: '2026-06-08T00:00:00.000Z'
      })
    ).toBe('1');
  });

  it('returns undefined when neither source has is_valid', () => {
    expect(
      getRunIsValidValue({
        id: 'run-empty',
        task_id: 'task-1',
        attempt_no: 1,
        status: 'succeeded',
        result_files: [],
        raw_outputs: { title: '无 is_valid' },
        created_at: '2026-06-08T00:00:00.000Z'
      })
    ).toBeUndefined();
  });
});
