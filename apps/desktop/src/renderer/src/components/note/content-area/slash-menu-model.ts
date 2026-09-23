import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { orderSlashMenuItemsByGroup } from './slash-menu-utils'

/**
 * One row of the `/` menu. `id` is BlockNote's own item key where there is one
 * (`heading_2`, `check_list`, …) and ours otherwise (`date`, `link_to_note`,
 * `template:<id>`). It is what recents are stored by, what picks the row's icon
 * and group, and what pairs a row with its secondary action — so it has to stay
 * stable across releases: recents written by an older build are looked up by it.
 */
export type SlashMenuItem = DefaultReactSuggestionItem & {
  id: string
  /** The markdown trigger that makes the same block without the menu. */
  hint?: string
  /** What ⌘/Ctrl+Enter does instead of the row's own action. */
  secondary?: { label: string; onItemClick: () => void }
  /** Where the query sits in the title, for highlighting. */
  match?: { start: number; end: number }
  /** Set when the row matched only through an alias, so the row can say why. */
  matchedAlias?: string
}

export type SlashMenuGroupId = 'blocks' | 'headings' | 'insert' | 'media' | 'ai' | 'templates'

export type SlashMenuGroupLabels = Record<SlashMenuGroupId | 'recent' | 'bestMatch', string>

// Row order at rest. Every command the menu has ever offered is still listed;
// the catalog only decides where it sits. An id missing here keeps its own
// group and lands after the catalogued groups, so a new upstream item shows up
// instead of vanishing.
const CATALOG: ReadonlyArray<readonly [SlashMenuGroupId, readonly string[]]> = [
  [
    'blocks',
    [
      'paragraph',
      'heading',
      'heading_2',
      'heading_3',
      'bullet_list',
      'numbered_list',
      'check_list',
      'toggle_list',
      'quote',
      'callout',
      'code_block',
      'divider'
    ]
  ],
  [
    'headings',
    [
      'heading_4',
      'heading_5',
      'heading_6',
      'toggle_heading',
      'toggle_heading_2',
      'toggle_heading_3'
    ]
  ],
  [
    'insert',
    [
      'link_to_note',
      'date',
      'remind',
      'task',
      'table',
      'math',
      'diagram',
      'whiteboard',
      'emoji',
      'insert_template'
    ]
  ],
  ['media', ['image', 'pdf', 'media', 'video', 'audio', 'file']],
  ['ai', ['ai']]
]

const TEMPLATE_PREFIX = 'template:'

// Each of these is a BlockNote input rule (or one of Memry's own triggers), so
// the row teaches a path that skips the menu next time.
const SHORTCUT_HINTS: Readonly<Record<string, string>> = {
  heading: '#',
  heading_2: '##',
  heading_3: '###',
  heading_4: '####',
  heading_5: '#####',
  heading_6: '######',
  bullet_list: '-',
  numbered_list: '1.',
  check_list: '[]',
  quote: '>',
  code_block: '```',
  divider: '---',
  link_to_note: '[[',
  date: '@',
  emoji: ':'
}

const CATALOG_POSITION = new Map<
  string,
  { group: SlashMenuGroupId; groupIndex: number; index: number }
>(
  CATALOG.flatMap(([group, ids], groupIndex) =>
    ids.map((id, index) => [id, { group, groupIndex, index }] as const)
  )
)

// Between Media and AI.
const UNCATALOGUED_GROUP_INDEX = CATALOG.findIndex(([group]) => group === 'ai') - 0.5
const TEMPLATES_GROUP_INDEX = CATALOG.length

function arrangeByCatalog(items: SlashMenuItem[], labels: SlashMenuGroupLabels): SlashMenuItem[] {
  const placed = items.map((item, originalIndex) => {
    const position = CATALOG_POSITION.get(item.id)
    const hint = item.hint ?? SHORTCUT_HINTS[item.id]
    if (position) {
      return {
        item: { ...item, hint, group: labels[position.group] },
        groupIndex: position.groupIndex,
        index: position.index,
        originalIndex
      }
    }
    if (item.id.startsWith(TEMPLATE_PREFIX)) {
      return {
        item: { ...item, hint, group: labels.templates },
        groupIndex: TEMPLATES_GROUP_INDEX,
        index: 0,
        originalIndex
      }
    }
    return {
      item: { ...item, hint },
      groupIndex: UNCATALOGUED_GROUP_INDEX,
      index: 0,
      originalIndex
    }
  })
  placed.sort(
    (a, b) => a.groupIndex - b.groupIndex || a.index - b.index || a.originalIndex - b.originalIndex
  )
  return orderSlashMenuItemsByGroup(placed.map((p) => p.item))
}

type Scored = { score: number; match?: SlashMenuItem['match']; matchedAlias?: string }

const WORD_BOUNDARY = /[\s\-_/(]/

function scoreItem(item: SlashMenuItem, query: string): Scored | null {
  const title = item.title.toLowerCase()
  const at = title.indexOf(query)
  if (at !== -1) {
    const match = { start: at, end: at + query.length }
    if (at === 0) return { score: 0, match }
    if (WORD_BOUNDARY.test(title[at - 1] ?? '')) return { score: 1, match }
    return { score: 2, match }
  }
  const aliases = item.aliases ?? []
  const prefixAlias = aliases.find((alias) => alias.toLowerCase().startsWith(query))
  if (prefixAlias) return { score: 3, matchedAlias: prefixAlias }
  const innerAlias = aliases.find((alias) => alias.toLowerCase().includes(query))
  if (innerAlias) return { score: 4, matchedAlias: innerAlias }
  return null
}

/**
 * Turns the flat list of everything the menu can do right now into what it
 * shows. With no query: the last few rows used, then every row in catalog
 * order. With a query: every match in catalog order, with the single best match
 * lifted into its own group on top when it is not already first — so rows do not jump around between keystrokes except for the
 * one the Enter key will pick.
 */
export function buildSlashMenuItems({
  items,
  query,
  recentIds,
  labels
}: {
  items: SlashMenuItem[]
  query: string
  recentIds: readonly string[]
  labels: SlashMenuGroupLabels
}): SlashMenuItem[] {
  const arranged = arrangeByCatalog(items, labels)
  const needle = query.trim().toLowerCase()

  if (!needle) {
    const recents = recentIds.flatMap((id) => {
      const found = arranged.find((item) => item.id === id)
      return found ? [{ ...found, group: labels.recent }] : []
    })
    return [...recents, ...arranged]
  }

  const matches: { item: SlashMenuItem; score: number }[] = []
  for (const item of arranged) {
    const scored = scoreItem(item, needle)
    if (!scored) continue
    matches.push({
      item: { ...item, match: scored.match, matchedAlias: scored.matchedAlias },
      score: scored.score
    })
  }
  if (matches.length === 0) return []

  let best = matches[0]
  for (const candidate of matches) {
    if (candidate.score < best.score) best = candidate
  }
  // Already on top: a "Best match" header would only rename its own group.
  if (best === matches[0]) return matches.map((m) => m.item)
  const rest = matches.filter((m) => m !== best).map((m) => m.item)
  return [{ ...best.item, group: labels.bestMatch }, ...orderSlashMenuItemsByGroup(rest)]
}

/**
 * Gives a row the action of another row as its ⌘/Ctrl+Enter alternative —
 * `Heading 2` → toggle heading 2, `Date` → reminder. Only when the target row is
 * in the list right now, so a flag or a table cell that removes the target also
 * removes the shortcut to it.
 */
export function withSecondaryActions(
  items: SlashMenuItem[],
  pairs: readonly { from: string; to: string; label: string }[]
): SlashMenuItem[] {
  return items.map((item) => {
    const pair = pairs.find((p) => p.from === item.id)
    if (!pair) return item
    const target = items.find((candidate) => candidate.id === pair.to)
    return target
      ? { ...item, secondary: { label: pair.label, onItemClick: target.onItemClick } }
      : item
  })
}

// ============================================================================
// Recents
// ============================================================================

export const SLASH_MENU_RECENTS_KEY = 'memry:slash-menu-recent'
const MAX_RECENTS = 3

/** Tolerates anything an older build, another tab, or a hand edit left behind. */
export function readSlashMenuRecents(): string[] {
  try {
    const raw = localStorage.getItem(SLASH_MENU_RECENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

/**
 * Templates are not recorded: they only appear once a query is typed, so a
 * recent template would take a slot and never be shown.
 */
export function recordSlashMenuRecent(id: string): void {
  if (id.startsWith(TEMPLATE_PREFIX)) return
  const next = [id, ...readSlashMenuRecents().filter((existing) => existing !== id)].slice(
    0,
    MAX_RECENTS
  )
  try {
    localStorage.setItem(SLASH_MENU_RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: recents are a convenience, not state.
  }
}
