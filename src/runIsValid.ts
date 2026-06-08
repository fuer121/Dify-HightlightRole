function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function getRunIsValidValue<T extends { is_valid?: unknown; raw_outputs?: unknown }>(run: T) {
  if (run.is_valid !== undefined) return run.is_valid;
  return asObject(run.raw_outputs)?.is_valid;
}
