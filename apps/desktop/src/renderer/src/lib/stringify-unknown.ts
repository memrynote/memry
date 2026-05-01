export function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'symbol') return value.description ?? value.toString()
  if (value instanceof Date) return value.toISOString()

  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return Object.prototype.toString.call(value)
  }
}
