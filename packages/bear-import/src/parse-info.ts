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

  const obj = raw as Record<string, unknown>

  return {
    uniqueIdentifier:
      typeof obj['net.shinyfrog.bear.uniqueIdentifier'] === 'string'
        ? obj['net.shinyfrog.bear.uniqueIdentifier']
        : undefined,
    created: toDate(obj['net.shinyfrog.bear.note-creation-date']),
    modified: toDate(obj['net.shinyfrog.bear.note-modification-date']),
    archived: toBool(obj['net.shinyfrog.bear.note-archived']),
    trashed: toBool(obj['net.shinyfrog.bear.note-trashed'])
  }
}
