import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockJournalEntry {
  id: string
  date: string
  body: string
  mood: number | null
  properties: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

function isoDate(daysAgo: number): string {
  const d = new Date(mockTimestamp(daysAgo))
  return d.toISOString().slice(0, 10)
}

const fixtures = [
  { daysAgo: 0, body: 'Today — focus on the Tauri migration spike.', mood: 4 },
  { daysAgo: 1, body: 'Shipped Phase C. Feels good. Ürünün adımları hızlanıyor.', mood: 5 },
  { daysAgo: 2, body: 'Debugging electron ABI issues. Tough day.', mood: 2 },
  { daysAgo: 3, body: 'Design review went well. Next up: mocks.', mood: 4 },
  { daysAgo: 4, body: 'Reviewed sync handler strategy pattern.', mood: 3 },
  { daysAgo: 5, body: 'Off day. Tested CRDT sign-out fix.', mood: 3 },
  { daysAgo: 6, body: 'Pair programming with Codex. Good second opinions.', mood: 4 }
]

const entries: MockJournalEntry[] = fixtures.map((f, i) => ({
  id: `journal-${i + 1}`,
  date: isoDate(f.daysAgo),
  body: f.body,
  mood: f.mood,
  properties: {},
  createdAt: mockTimestamp(f.daysAgo),
  updatedAt: mockTimestamp(f.daysAgo)
}))

export const journalRoutes: MockRouteMap = {
  journal_list: async () => entries,
  journal_get_by_date: async (args) => {
    const { date } = args as { date: string }
    const entry = entries.find((e) => e.date === date)
    if (!entry) throw new Error(`Journal entry for ${date} not found`)
    return entry
  },
  journal_get: async (args) => {
    const { id } = args as { id: string }
    const entry = entries.find((e) => e.id === id)
    if (!entry) throw new Error(`Journal entry ${id} not found`)
    return entry
  },
  journal_upsert: async (args) => {
    const { date, body, mood, properties } = args as {
      date: string
      body: string
      mood?: number | null
      properties?: Record<string, unknown>
    }
    const existing = entries.find((e) => e.date === date)
    if (existing) {
      Object.assign(existing, {
        body,
        mood: mood ?? existing.mood,
        properties: properties ?? existing.properties,
        updatedAt: Date.now()
      })
      return existing
    }
    const now = Date.now()
    const entry: MockJournalEntry = {
      id: mockId('journal'),
      date,
      body,
      mood: mood ?? null,
      properties: properties ?? {},
      createdAt: now,
      updatedAt: now
    }
    entries.unshift(entry)
    return entry
  },
  journal_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = entries.findIndex((e) => e.id === id)
    if (idx >= 0) entries.splice(idx, 1)
    return { ok: true }
  },

  // Contract: HeatmapEntry[] — { date, characterCount, level }
  journal_get_heatmap: async () =>
    entries.map((e) => {
      const characterCount = e.body.length
      const level: 0 | 1 | 2 | 3 | 4 =
        characterCount === 0
          ? 0
          : characterCount < 40
            ? 1
            : characterCount < 80
              ? 2
              : characterCount < 120
                ? 3
                : 4
      return { date: e.date, characterCount, level }
    }),
  journal_get_month: async () => entries,
  journal_get_year_stats: async () => ({
    year: new Date().getFullYear(),
    totalEntries: entries.length,
    totalCharacters: entries.reduce((sum, e) => sum + e.body.length, 0),
    streak: { current: 0, longest: 0 }
  }),
  journal_get_day_context: async () => ({ tasks: [], events: [], overdueCount: 0 })
}
