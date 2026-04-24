import type { MockRouteMap } from './types'

interface MockSearchHit {
  kind: 'note' | 'task' | 'journal' | 'inbox' | 'bookmark'
  id: string
  title: string
  snippet: string
  score: number
  updatedAt: number
}

const fixtures: MockSearchHit[] = [
  {
    kind: 'note',
    id: 'note-1',
    title: 'Welcome to Memry (Tauri)',
    snippet: 'This is a mock note for M1 visual parity.',
    score: 0.95,
    updatedAt: Date.now()
  },
  {
    kind: 'note',
    id: 'note-4',
    title: 'Ideas list',
    snippet: 'Random brainstorm of mock content.',
    score: 0.82,
    updatedAt: Date.now()
  },
  {
    kind: 'task',
    id: 'task-1',
    title: 'Mock task #1',
    snippet: 'First mock task.',
    score: 0.75,
    updatedAt: Date.now()
  },
  {
    kind: 'journal',
    id: 'journal-1',
    title: 'Today — focus on the Tauri migration spike.',
    snippet: 'Journal entry.',
    score: 0.7,
    updatedAt: Date.now()
  },
  {
    kind: 'inbox',
    id: 'inbox-1',
    title: 'Quick thought — mock',
    snippet: 'Dashboard redesign note.',
    score: 0.65,
    updatedAt: Date.now()
  },
  {
    kind: 'bookmark',
    id: 'bookmark-1',
    title: 'Tailwind CSS docs',
    snippet: 'Mock bookmark entry.',
    score: 0.6,
    updatedAt: Date.now()
  }
]

const recent: string[] = []

const suggestionPool = ['mock', 'meeting', 'memory', 'milestone', 'markdown', 'migration']

export const searchRoutes: MockRouteMap = {
  search_query: async (args) => {
    const { q } = args as { q: string }
    if (!q.trim()) return []
    if (!recent.includes(q)) {
      recent.unshift(q)
      if (recent.length > 10) recent.pop()
    }
    const needle = q.toLowerCase()
    return fixtures.filter(
      (f) => f.title.toLowerCase().includes(needle) || f.snippet.toLowerCase().includes(needle)
    )
  },
  search_recent: async () => [...recent],
  search_clear_recent: async () => {
    recent.length = 0
    return { ok: true }
  },
  search_suggestions: async (args) => {
    const { prefix } = (args as { prefix?: string }) ?? {}
    if (!prefix) return suggestionPool
    const p = prefix.toLowerCase()
    return suggestionPool.filter((s) => s.toLowerCase().startsWith(p))
  }
}
