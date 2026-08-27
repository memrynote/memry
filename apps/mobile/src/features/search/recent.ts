import { getMeta, setMeta, type VaultDb } from '@/db/index'
import { RECENT_SEARCHES_KEY } from '@/db/keys'
import type { RecentSearchStore } from './repo'

const MAX_RECENT = 5

export function createSqliteRecentSearchStore(db: VaultDb): RecentSearchStore {
  return {
    async list(): Promise<string[]> {
      return parseList(await getMeta(db, RECENT_SEARCHES_KEY))
    },
    async record(query: string): Promise<void> {
      const trimmed = query.trim()
      if (trimmed.length === 0) return
      const key = trimmed.toLowerCase()
      const existing = parseList(await getMeta(db, RECENT_SEARCHES_KEY))
      const next = [trimmed, ...existing.filter((entry) => entry.toLowerCase() !== key)]
      await setMeta(db, RECENT_SEARCHES_KEY, JSON.stringify(next.slice(0, MAX_RECENT)))
    },
    async clear(): Promise<void> {
      await setMeta(db, RECENT_SEARCHES_KEY, '[]')
    }
  }
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const entries = value.filter((entry) => typeof entry === 'string')
  return entries.length === value.length ? entries : []
}
