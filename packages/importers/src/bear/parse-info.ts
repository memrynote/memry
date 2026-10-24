import type { BearInfo } from './types.ts'

function toDate(value: unknown): Date | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? undefined : d
  }
  return undefined
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseInfo(raw: unknown): BearInfo {
  if (!isRecord(raw)) {
    return { archived: false, trashed: false }
  }

  // Real Bear exports nest note metadata under the `net.shinyfrog.bear` key.
  const outer = raw
  const inner = outer['net.shinyfrog.bear']
  const obj = isRecord(inner) ? inner : outer

  return {
    uniqueIdentifier:
      typeof obj['uniqueIdentifier'] === 'string' ? obj['uniqueIdentifier'] : undefined,
    created: toDate(obj['creationDate']),
    modified: toDate(obj['modificationDate']),
    archived: toBool(obj['archived']),
    trashed: toBool(obj['trashed'])
  }
}
