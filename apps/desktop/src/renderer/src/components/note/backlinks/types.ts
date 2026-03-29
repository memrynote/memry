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
  mentions: Mention[] // All mentions of current note
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
