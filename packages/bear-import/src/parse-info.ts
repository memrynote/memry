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

export function parseInfo(raw: unknown): BearInfo {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { archived: false, trashed: false }
  }

  // Real Bear exports nest note metadata under the `net.shinyfrog.bear` key.
  const outer = raw as Record<string, unknown>
  const inner = outer['net.shinyfrog.bear']
  const obj =
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : outer

  return {
    uniqueIdentifier:
      typeof obj['uniqueIdentifier'] === 'string' ? obj['uniqueIdentifier'] : undefined,
    created: toDate(obj['creationDate']),
    modified: toDate(obj['modificationDate']),
    archived: toBool(obj['archived']),
    trashed: toBool(obj['trashed'])
  }
}
