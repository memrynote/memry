import type { Backlink as WireBacklink, LinkVia } from '@memry/contracts/notes-api'

export interface Mention {
  id: string
  snippet: string // Context around the link
  linkStart: number // Position of [[link]] in snippet
  linkEnd: number
}

export interface Backlink {
  id: string
  noteId: string
  noteTitle: string
  folder?: string // Parent folder name
  date: Date // When link was created or note updated
  mentions: Mention[] // The text around each link, up to the source's snippet bound
  mentionCount: number // Every link in the source, past the bound too
  truncated: boolean // Some links have no `mentions` entry
  via?: LinkVia // Set for relation-property, canvas-arrow and portal entries
}

// A source note can reference the target both via [[wikilink]] and via a
// relation property, producing two distinct Backlink entries with the same
// sourceId. BacklinksSection keys its list on `id`, so the two must not
// collide — this is the one place that decides how they're disambiguated.
// note.tsx and journal.tsx both call this rather than inlining the formula.
export function backlinkId(sourceId: string, via: Backlink['via']): string {
  if (!via) return sourceId
  // A canvas entry is one per canvas: the same pair of notes joined on two
  // canvases is two connections.
  if (via.kind === 'canvas') return `${sourceId}:canvas:${via.canvasId}`
  // A portal entry is one per host note: the host's several portals to this
  // note collapse into a single backlink.
  if (via.kind === 'portal') return `${sourceId}:portal`
  return `${sourceId}:property:${via.propertyName}`
}

export type BacklinkSortOption = 'recent' | 'alphabetical' | 'mentions'

export interface BacklinksSectionProps {
  backlinks: Backlink[]
  isLoading?: boolean
  initialCount?: number // Default 5, how many to show initially
  collapsible?: boolean // Allow collapse entire section
  defaultCollapsed?: boolean
  sortBy?: BacklinkSortOption
  onSortChange?: (sort: BacklinkSortOption) => void
  onBacklinkClick: (noteId: string, mention?: Mention) => void
  onShowMore?: () => void // For lazy loading
}

// Format date for display
export function formatBacklinkDate(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`

  // Format as "Dec 3" or "Dec 3, 2023" if different year
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' })
  }
  return date.toLocaleDateString('en-US', options)
}

/**
 * The card for a backlink as `notes:get-links` sends it, in `folder`. The count is every link in
 * the source, which the card shows and the panel sorts and totals by; a source whose snippets
 * stopped at the size bound sends it with `truncated`. Electron sends neither: its count is the
 * snippets it sent. note.tsx and journal.tsx both map through this.
 */
export function toBacklink(wire: WireBacklink, folder: string, date: Date): Backlink {
  const contexts = wire.contexts ?? []
  return {
    id: backlinkId(wire.sourceId, wire.via),
    noteId: wire.sourceId,
    noteTitle: wire.sourceTitle,
    folder,
    date,
    mentions: contexts.map((ctx, i) => ({
      id: `mention-${wire.sourceId}-${i}`,
      snippet: ctx.snippet,
      linkStart: ctx.linkStart,
      linkEnd: ctx.linkEnd
    })),
    mentionCount: wire.mentionCount ?? contexts.length,
    truncated: wire.truncated ?? false,
    via: wire.via
  }
}
