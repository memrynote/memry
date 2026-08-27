import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View, type ListRenderItemInfo } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import type { IconName } from '@/components/ui/icon'
import { ListRow } from '@/components/ui/list-row'
import { SearchField } from '@/components/ui/search-field'
import { SectionHeader } from '@/components/ui/section-header'
import type {
  JumpTarget,
  JumpTargetKind,
  RecentSearchStore,
  SearchHit,
  SearchRepo,
  SearchScope
} from '@/features/search/repo'
import {
  formatJournalDate,
  localIsoDay,
  noteSubtitle,
  taskSubtitle
} from '@/features/search/subtitle'
import { createLogger } from '@/lib/logger'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

const log = createLogger('SearchScreen')

const DEBOUNCE_MS = 200

// Board 06 puts the empty block's top 120 below the search field rather than
// centring it in the space left over. Centring drifts with the device height;
// this distance does not.
const EMPTY_TOP = 120

type HitKind = SearchHit['kind']

const SCOPES: { key: SearchScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'note', label: 'Notes' },
  { key: 'task', label: 'Tasks' },
  { key: 'journal', label: 'Journals' }
]

const GROUPS: { kind: HitKind; label: string }[] = [
  { kind: 'note', label: 'NOTES' },
  { kind: 'task', label: 'TASKS' },
  { kind: 'journal', label: 'JOURNALS' }
]

const HIT_ICONS: Record<HitKind, IconName> = { note: 'note', task: 'task', journal: 'journal' }

const JUMP_ICONS: Record<JumpTargetKind, IconName> = {
  'todays-journal': 'journal',
  inbox: 'inbox',
  'overdue-tasks': 'task'
}

const SCOPE_LABELS: Record<HitKind, string> = {
  note: 'Notes',
  task: 'Tasks',
  journal: 'Journals'
}

interface RecentLine {
  query: string
  count: number
}

interface Results {
  query: string
  hits: SearchHit[]
  // Relative subtitles are anchored to the response, not to render time, so a
  // row cannot silently age from "1 hour ago" to "2 hours ago" mid-scroll.
  searchedAt: number
}

type ViewState =
  | { kind: 'entry'; recent: RecentLine[] }
  | { kind: 'results'; hits: SearchHit[] }
  | { kind: 'empty'; query: string; scope: SearchScope; total: number }

type ListItem =
  | { kind: 'header'; key: string; label: string; count?: number }
  | { kind: 'recentHeader'; key: string; onClear: () => void }
  | { kind: 'recent'; key: string; query: string; subtitle: string; onPress: () => void }
  | {
      kind: 'row'
      key: string
      title: string
      subtitle?: string
      icon: IconName
      accessibilityLabel?: string
      onPress: () => void
    }

function countByScope(hits: SearchHit[]): Record<SearchScope, number> {
  const counts: Record<SearchScope, number> = { all: hits.length, note: 0, task: 0, journal: 0 }
  for (const hit of hits) counts[hit.kind] += 1
  return counts
}

function resultLabel(count: number): string {
  if (count === 0) return 'No results'
  return count === 1 ? '1 result' : `${count} results`
}

function hitTitle(hit: SearchHit): string {
  return hit.kind === 'journal' ? formatJournalDate(hit.date) : hit.title
}

function hitSubtitle(hit: SearchHit, now: number, todayIso: string): string | undefined {
  switch (hit.kind) {
    case 'note':
      return noteSubtitle(hit, now)
    case 'task':
      return taskSubtitle(hit, todayIso)
    case 'journal':
      return hit.snippet ?? undefined
  }
}

function emptyBody(query: string, scope: SearchScope, total: number): string {
  if (scope !== 'all' && total > 0) {
    return `Nothing under ${SCOPE_LABELS[scope]} matches “${query}”.`
  }
  return `Nothing in this vault matches “${query}”. Older note bodies still syncing are searched as they land.`
}

function renderItem({ item }: ListRenderItemInfo<ListItem>) {
  switch (item.kind) {
    case 'header':
      return <SectionHeader label={item.label} count={item.count} />
    case 'recentHeader':
      return <SectionHeader label="RECENT" action={{ label: 'Clear', onPress: item.onClear }} />
    case 'recent':
      return (
        <ListRow
          variant="note"
          icon="search"
          title={item.query}
          subtitle={item.subtitle}
          onPress={item.onPress}
        />
      )
    case 'row':
      return (
        <ListRow
          variant="note"
          icon={item.icon}
          title={item.title}
          subtitle={item.subtitle}
          accessibilityLabel={item.accessibilityLabel}
          onPress={item.onPress}
        />
      )
  }
}

export interface SearchScreenProps {
  /**
   * `repo` and `recent` are effect dependencies, so they must be stable across
   * renders. Building them in a caller's render body restarts the debounce
   * every render, and re-runs one `countMatches` per recent entry with it.
   */
  repo: SearchRepo
  recent: RecentSearchStore
  jumpTargets: JumpTarget[]
  initialQuery?: string
  initialScope?: SearchScope
  onOpenHit: (hit: SearchHit) => void
  onJump: (target: JumpTarget) => void
  onCancel: () => void
  onSearchAllVaults?: () => void
}

export function SearchScreen({
  repo,
  recent,
  jumpTargets,
  initialQuery = '',
  initialScope = 'all',
  onOpenHit,
  onJump,
  onCancel,
  onSearchAllVaults
}: SearchScreenProps) {
  const c = useColors()
  const [query, setQuery] = useState(initialQuery)
  const [scope, setScope] = useState<SearchScope>(initialScope)
  const [recentLines, setRecentLines] = useState<RecentLine[]>([])
  const [results, setResults] = useState<Results | null>(null)

  const trimmed = query.trim()
  const atEntry = trimmed === ''

  useEffect(() => {
    if (atEntry) return
    let dropped = false
    const timer = setTimeout(() => {
      repo.search(trimmed).then(
        (hits) => {
          if (!dropped) setResults({ query: trimmed, hits, searchedAt: Date.now() })
        },
        (err: unknown) => {
          log.error('Search failed', { error: String(err) })
          // Resolved as an empty response rather than left pending: otherwise
          // the screen keeps another query's rows on screen, with no signal,
          // until the user happens to type again.
          if (!dropped) setResults({ query: trimmed, hits: [], searchedAt: Date.now() })
        }
      )
    }, DEBOUNCE_MS)
    // A slow early response cannot overwrite a fast later one.
    return () => {
      dropped = true
      clearTimeout(timer)
    }
  }, [atEntry, trimmed, repo])

  useEffect(() => {
    if (!atEntry) return
    let dropped = false
    recent
      .list()
      .then(async (queries) => {
        const counts = await Promise.all(queries.map((entry) => repo.countMatches(entry)))
        if (!dropped)
          setRecentLines(queries.map((entry, i) => ({ query: entry, count: counts[i] })))
      })
      .catch((err: unknown) => log.error('Recent searches failed', { error: String(err) }))
    return () => {
      dropped = true
    }
  }, [atEntry, recent, repo])

  const counts = useMemo(() => countByScope(results?.hits ?? []), [results])

  const viewState = useMemo<ViewState>(() => {
    if (atEntry) return { kind: 'entry', recent: recentLines }
    const visible =
      scope === 'all'
        ? (results?.hits ?? [])
        : (results?.hits ?? []).filter((h) => h.kind === scope)
    // Gated on the response BELONGING to the current query. Rows may lag by a
    // debounce while a refinement is in flight, which is invisible, but the
    // empty copy names the query, and naming the one the user already deleted
    // is a lie on screen.
    if (results?.query === trimmed && visible.length === 0) {
      return { kind: 'empty', query: trimmed, scope, total: counts.all }
    }
    return { kind: 'results', hits: visible }
  }, [atEntry, recentLines, results, trimmed, scope, counts.all])

  // Emptying the field abandons the search rather than suspending it. Keeping
  // the hits would render the old query's rows under a new one, and keeping the
  // scope would land the next recent-search tap straight on "Nothing under
  // Tasks" for a query the user never scoped. It happens here rather than in an
  // effect on `atEntry` so the reset is one render, not a cascade.
  const handleQueryChange = useCallback((next: string) => {
    setQuery(next)
    if (next.trim() !== '') return
    setResults(null)
    setScope('all')
  }, [])

  const handleClearRecent = useCallback(() => {
    setRecentLines([])
    recent
      .clear()
      .catch((err: unknown) => log.error('Clearing recent searches failed', { error: String(err) }))
  }, [recent])

  const handleOpenHit = useCallback(
    (hit: SearchHit) => {
      // Recorded on open rather than on keystroke so the recent list stays a
      // list of searches the user finished, not a transcript of their typing.
      const finished = results?.query
      if (finished) {
        recent
          .record(finished)
          .catch((err: unknown) =>
            log.error('Recording a recent search failed', { error: String(err) })
          )
      }
      onOpenHit(hit)
    },
    [recent, results, onOpenHit]
  )

  const items = useMemo<ListItem[]>(() => {
    if (viewState.kind === 'empty') return []

    const list: ListItem[] = []

    if (viewState.kind === 'entry') {
      if (viewState.recent.length > 0) {
        list.push({ kind: 'recentHeader', key: 'header:recent', onClear: handleClearRecent })
      }
      for (const line of viewState.recent) {
        list.push({
          kind: 'recent',
          key: `recent:${line.query}`,
          query: line.query,
          subtitle: resultLabel(line.count),
          onPress: () => setQuery(line.query)
        })
      }
      list.push({ kind: 'header', key: 'header:jump', label: 'JUMP TO' })
      for (const target of jumpTargets) {
        list.push({
          kind: 'row',
          key: `jump:${target.kind}`,
          title: target.title,
          subtitle: target.subtitle,
          icon: JUMP_ICONS[target.kind],
          accessibilityLabel: `${target.title}, ${target.subtitle}`,
          onPress: () => onJump(target)
        })
      }
      return list
    }

    if (!results) return []
    const todayIso = localIsoDay(results.searchedAt)
    for (const group of GROUPS) {
      const groupHits = viewState.hits.filter((hit) => hit.kind === group.kind)
      if (groupHits.length === 0) continue
      list.push({
        kind: 'header',
        key: `header:${group.kind}`,
        label: group.label,
        count: groupHits.length
      })
      for (const hit of groupHits) {
        list.push({
          kind: 'row',
          key: `hit:${hit.kind}:${hit.id}`,
          title: hitTitle(hit),
          subtitle: hitSubtitle(hit, results.searchedAt, todayIso),
          icon: HIT_ICONS[hit.kind],
          onPress: () => handleOpenHit(hit)
        })
      }
    }
    return list
  }, [viewState, results, jumpTargets, handleClearRecent, handleOpenHit, onJump])

  return (
    <View style={[styles.root, { backgroundColor: c.canvas.background }]}>
      <View style={styles.header}>
        <SearchField
          style={styles.field}
          value={query}
          onChangeText={handleQueryChange}
          placeholder="Search notes, tasks, journals"
          autoFocus
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        <Pressable
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={onCancel}
          style={styles.cancel}
        >
          <AppText variant="body" color={c.tint.base}>
            Cancel
          </AppText>
        </Pressable>
      </View>

      {/*
        Board 06 draws no chips, because a query that matched nothing has
        nothing to scope. Above zero they must render even on the empty state:
        a scope with no hits is escaped by tapping another chip, and hiding
        them there would strand the user on a dead screen.
      */}
      {viewState.kind === 'entry' || counts.all === 0 ? null : (
        <View style={styles.scopes}>
          {SCOPES.map((entry) => {
            const selected = entry.key === scope
            return (
              <Pressable
                key={entry.key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                hitSlop={{ top: 9, bottom: 9 }}
                onPress={() => setScope(entry.key)}
              >
                <Chip
                  label={`${entry.label} ${counts[entry.key]}`}
                  variant={selected ? 'active' : 'tag'}
                />
              </Pressable>
            )
          })}
        </View>
      )}

      {viewState.kind === 'empty' ? (
        <View style={styles.emptyArea}>
          <EmptyState
            icon="search"
            title="No matches"
            body={emptyBody(viewState.query, viewState.scope, viewState.total)}
          />
          {onSearchAllVaults && viewState.scope === 'all' ? (
            <Button
              label="Search all vaults"
              variant="ghost"
              onPress={onSearchAllVaults}
              style={styles.ghost}
            />
          ) : null}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
        />
      )}

      {viewState.kind === 'results' && counts.all > 0 ? (
        <AppText variant="footnote" color={c.text.secondary} style={styles.footer}>
          Results are full-text. Semantic search runs on desktop only.
        </AppText>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The list has to claim the space the footer does not, or a short result set
  // pulls the full-text footer up under the last row instead of leaving it on
  // the bottom edge where board 11 draws it.
  list: { flex: 1 },
  // The field and the Cancel pressable are both 36 tall against a flex-start
  // row, so the 24pt label centres on the field rather than on the 56pt bar.
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.s12,
    paddingHorizontal: sizes.gutter,
    paddingTop: space.s8
  },
  field: { flex: 1 },
  cancel: { height: 36, justifyContent: 'center' },
  scopes: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.s8,
    paddingHorizontal: sizes.gutter,
    paddingBottom: space.s12
  },
  emptyArea: { flex: 1, paddingTop: EMPTY_TOP, gap: space.s16 },
  ghost: { marginHorizontal: sizes.gutter },
  // 10 above plus two 18pt footnote lines plus 12 below is the 58 tall footer.
  footer: { paddingHorizontal: sizes.gutter, paddingTop: 10, paddingBottom: space.s12 }
})
