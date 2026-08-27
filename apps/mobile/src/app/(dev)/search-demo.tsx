import { useLocalSearchParams } from 'expo-router'
import { StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import type { IconName } from '@/components/ui/icon'
import { TabBar } from '@/components/ui/tab-bar'
import type {
  JumpTarget,
  RecentSearchStore,
  SearchHit,
  SearchRepo,
  SearchScope
} from '@/features/search/repo'
import { SearchScreen } from '@/features/search/search-screen'
import { formatJournalDate, localIsoDay } from '@/features/search/subtitle'
import { createLogger } from '@/lib/logger'
import { useColors } from '@/theme/use-colors'

const log = createLogger('SearchDemo')

const NOW = Date.now()
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const HITS: SearchHit[] = [
  {
    kind: 'note',
    id: 'note-weekly-review',
    title: 'Weekly review',
    folderPath: 'Journal',
    updatedAt: NOW - 2 * HOUR_MS
  },
  {
    kind: 'note',
    id: 'note-review-checklist',
    title: 'Review checklist',
    folderPath: 'Projects/Ops',
    updatedAt: NOW - 3 * DAY_MS
  },
  {
    kind: 'note',
    id: 'note-design-review',
    title: 'Design review notes',
    folderPath: 'Inbox',
    updatedAt: NOW - 9 * DAY_MS
  },
  {
    kind: 'task',
    id: 'task-review-pr',
    title: 'Review PR #1858',
    dueDate: localIsoDay(NOW),
    completedAt: null,
    projectName: 'Memry'
  },
  {
    kind: 'task',
    id: 'task-review-spend',
    title: 'Review Q3 spend',
    dueDate: localIsoDay(NOW - 4 * DAY_MS),
    completedAt: null,
    projectName: 'Personal'
  },
  {
    kind: 'journal',
    id: 'journal-yesterday',
    date: localIsoDay(NOW - DAY_MS),
    snippet: '…ran the weekly review with…',
    updatedAt: NOW - DAY_MS
  }
]

// A journal entry has no title, so its snippet is the text the fixture matches
// on. Otherwise no query could ever surface the JOURNALS group.
function searchText(hit: SearchHit): string {
  return hit.kind === 'journal' ? (hit.snippet ?? '') : hit.title
}

function matches(query: string): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return HITS.filter((hit) => searchText(hit).toLowerCase().includes(needle))
}

const repo: SearchRepo = {
  search: (query) => Promise.resolve(matches(query)),
  countMatches: (query) => Promise.resolve(matches(query).length)
}

function createMemoryRecentStore(seed: string[]): RecentSearchStore {
  let queries = seed
  return {
    list: () => Promise.resolve(queries),
    record: (query) => {
      queries = [query, ...queries.filter((entry) => entry !== query)]
      return Promise.resolve()
    },
    clear: () => {
      queries = []
      return Promise.resolve()
    }
  }
}

const recent = createMemoryRecentStore(['weekly review', '#research', 'argon2id'])

const JUMP_TARGETS: JumpTarget[] = [
  {
    kind: 'todays-journal',
    title: "Today's journal",
    subtitle: formatJournalDate(localIsoDay(NOW)),
    count: 0
  },
  { kind: 'inbox', title: 'Inbox', subtitle: '7 to triage', count: 7 },
  { kind: 'overdue-tasks', title: 'Overdue tasks', subtitle: '2', count: 2 }
]

const TABS: { key: string; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'notes', label: 'Notes', icon: 'note' },
  { key: 'tasks', label: 'Tasks', icon: 'task' },
  { key: 'journal', label: 'Journal', icon: 'journal' },
  { key: 'more', label: 'More', icon: 'more' }
]

// `scoped` is the state no board draws: a scope with no hits while other
// scopes have some. It is the case that decides whether the chips render on an
// empty screen, so it needs to be reachable for a screenshot.
const DEMO_STATES: Record<string, { query: string; scope: SearchScope }> = {
  entry: { query: '', scope: 'all' },
  results: { query: 'review', scope: 'all' },
  empty: { query: 'argon2id rotation', scope: 'all' },
  scoped: { query: 'checklist', scope: 'task' }
}

function useDemoState(): string {
  const { state } = useLocalSearchParams<{ state?: string }>()
  const key = state?.trim().toLowerCase() ?? ''
  return key in DEMO_STATES ? key : 'entry'
}

const handleOpenHit = (hit: SearchHit) => log.info('open hit', { kind: hit.kind, id: hit.id })
const handleJump = (target: JumpTarget) => log.info('jump', { kind: target.kind })
const handleCancel = () => log.info('cancel')
const handleSearchAllVaults = () => log.info('search all vaults')

export default function SearchDemoScreen() {
  const c = useColors()
  const state = useDemoState()

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.root, { backgroundColor: c.canvas.background }]}
    >
      {/*
        Keyed on the state so `openurl` to a different `?state=` remounts the
        screen. `initialQuery` is read once at mount, and expo-router reuses
        the mounted route on a same-path navigation, so without this the second
        screenshot of a session silently shows the first board.
      */}
      <SearchScreen
        key={state}
        repo={repo}
        recent={recent}
        jumpTargets={JUMP_TARGETS}
        initialQuery={DEMO_STATES[state].query}
        initialScope={DEMO_STATES[state].scope}
        onOpenHit={handleOpenHit}
        onJump={handleJump}
        onCancel={handleCancel}
        onSearchAllVaults={handleSearchAllVaults}
      />
      <TabBar
        items={TABS.map((tab) => ({
          ...tab,
          focused: tab.key === 'home',
          onPress: () => log.info('tab press', { key: tab.key }),
          onLongPress: () => log.info('tab long press', { key: tab.key })
        }))}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 }
})
