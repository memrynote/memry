/** A non-null, non-array object. Narrows `unknown` without an assertion. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Any non-null object, arrays included. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
