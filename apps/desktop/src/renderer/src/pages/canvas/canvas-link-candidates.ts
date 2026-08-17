/**
 * Turns the link picker's four search sources into one ordered list of
 * linkable vault items.
 *
 * Pure: the sources are passed in already resolved, so the mapping — which
 * search row becomes which `memry://` kind, which rows cannot be linked at all
 * — is unit-testable without IPC.
 */

import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { buildMemryHref, type MemryLinkKind } from '@/lib/memry-links'

export interface LinkCandidate {
  kind: MemryLinkKind
  id: string
  title: string
  /** Second line: a path, a project, a day — whatever identifies this one. */
  subtitle: string
  /** The item's own icon, when it has one (notes only today). */
  emoji?: string | null
  /** Built up front so selecting a row never has to re-derive the link. */
  href: string
  /** For inbox rows, the item type that picks the row icon. */
  itemType?: string
}

/** cmdk needs a value per row that cannot collide across kinds. */
export function candidateKey(candidate: Pick<LinkCandidate, 'kind' | 'id'>): string {
  return `${candidate.kind}:${candidate.id}`
}

function withHref(
  input: Omit<LinkCandidate, 'href'> & { date?: string | null }
): LinkCandidate | null {
  // The title travels inside the href as a display hint, so Excalidraw's link
  // bubble can say "memrynote Launch" rather than "memry://note/s5b2qadr6tg4".
  const href = buildMemryHref({
    kind: input.kind,
    id: input.id,
    date: input.date,
    label: input.title
  })
  if (!href) return null
  const { date: _date, ...rest } = input
  return { ...rest, href }
}

/**
 * Quick-search returns notes, journals, tasks and inbox items in one response.
 * A "note" row whose `fileType` is a binary is a filed PDF/image/audio/video —
 * it links as `file`, so it opens in the viewer rather than the markdown
 * editor (#800).
 */
export function candidatesFromSearch(results: readonly SearchResultItem[]): LinkCandidate[] {
  const out: LinkCandidate[] = []

  for (const result of results) {
    const metadata = result.metadata

    if (metadata.type === 'note') {
      const isBinary = metadata.fileType != null && metadata.fileType !== 'markdown'
      const candidate = withHref({
        kind: isBinary ? 'file' : 'note',
        id: result.id,
        title: result.title,
        subtitle: metadata.path,
        emoji: metadata.emoji
      })
      if (candidate) out.push(candidate)
      continue
    }

    if (metadata.type === 'journal') {
      // A journal links by its date, not by the index row's id.
      const candidate = withHref({
        kind: 'journal',
        id: metadata.date,
        title: result.title,
        subtitle: metadata.path
      })
      if (candidate) out.push(candidate)
      continue
    }

    if (metadata.type === 'task') {
      const candidate = withHref({
        kind: 'task',
        id: result.id,
        title: result.title,
        subtitle: metadata.projectName
      })
      if (candidate) out.push(candidate)
      continue
    }

    const candidate = withHref({
      kind: 'inbox',
      id: result.id,
      title: result.title,
      subtitle: metadata.sourceTitle ?? metadata.sourceUrl ?? '',
      itemType: metadata.itemType
    })
    if (candidate) out.push(candidate)
  }

  return out
}

/**
 * An event with no start has no day for the Calendar to focus, so it cannot be
 * linked at all — `buildMemryHref` refuses it and the row is dropped rather
 * than offered as something that would do nothing when clicked.
 */
export function candidatesFromEvents(events: readonly CalendarEventSearchItem[]): LinkCandidate[] {
  const out: LinkCandidate[] = []
  for (const event of events) {
    const candidate = withHref({
      kind: 'calendar_event',
      id: event.id,
      title: event.title,
      subtitle: event.startAt?.slice(0, 10) ?? '',
      date: event.startAt ? event.startAt.slice(0, 10) : null
    })
    if (candidate) out.push(candidate)
  }
  return out
}

export interface ProjectLike {
  id: string
  name: string
  color?: string | null
  archivedAt?: string | null
}

/**
 * Projects and folders are not in the search index, so they are filtered here
 * against the same query the indexed sources were given.
 */
export function candidatesFromProjects(
  projects: readonly ProjectLike[],
  query: string
): LinkCandidate[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const out: LinkCandidate[] = []
  for (const project of projects) {
    if (project.archivedAt) continue
    if (!project.name.toLowerCase().includes(needle)) continue
    const candidate = withHref({
      kind: 'project',
      id: project.id,
      title: project.name,
      subtitle: ''
    })
    if (candidate) out.push(candidate)
  }
  return out
}

export interface FolderLike {
  path: string
  icon?: string | null
}

export function candidatesFromFolders(
  folders: readonly FolderLike[],
  query: string
): LinkCandidate[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const out: LinkCandidate[] = []
  for (const folder of folders) {
    if (!folder.path.toLowerCase().includes(needle)) continue
    const name = folder.path.split('/').filter(Boolean).pop() ?? folder.path
    const candidate = withHref({
      kind: 'folder',
      id: folder.path,
      title: name,
      // The leaf is the title, so the full path is what disambiguates two
      // folders that share a name.
      subtitle: folder.path,
      emoji: folder.icon
    })
    if (candidate) out.push(candidate)
  }
  return out
}

// Scheme + colon, so mailto: and tel: count too. Two characters minimum keeps
// a Windows drive letter ("C:\\...") from reading as one.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]+:/i
const LOOKS_LIKE_HOST = /^[^\s/?#]+\.[^\s/?#]{2,}(?:[/?#]\S*)?$/

/**
 * A typed address, if the query is one.
 *
 * Our picker replaces Excalidraw's own URL box (its "Create link" action opens
 * this instead), so a plain web address has to remain linkable from here or the
 * feature would have taken something away. A bare host gets https:// — the same
 * assumption a browser's address bar makes.
 */
export function urlFromQuery(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  if (HAS_SCHEME.test(trimmed)) return trimmed
  if (LOOKS_LIKE_HOST.test(trimmed)) return `https://${trimmed}`
  return null
}

/** Display order: the kinds a canvas links most often come first. */
export const LINK_GROUP_ORDER = [
  'note',
  'file',
  'task',
  'calendar_event',
  'inbox',
  'journal',
  'project',
  'folder'
] as const

export type LinkGroups = Record<(typeof LINK_GROUP_ORDER)[number], LinkCandidate[]>

export function groupCandidates(candidates: readonly LinkCandidate[]): LinkGroups {
  const groups: LinkGroups = {
    note: [],
    file: [],
    task: [],
    calendar_event: [],
    inbox: [],
    journal: [],
    project: [],
    folder: []
  }
  for (const candidate of candidates) {
    groups[candidate.kind].push(candidate)
  }
  return groups
}

export function hasAnyCandidate(groups: LinkGroups): boolean {
  return LINK_GROUP_ORDER.some((kind) => groups[kind].length > 0)
}
