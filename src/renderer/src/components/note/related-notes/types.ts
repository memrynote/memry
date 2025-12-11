export interface RelatedNote {
  id: string
  noteId: string
  title: string
  icon?: string
  similarity: number // 0-100
  reason: string // Why it's related
  folder?: string
  updatedAt: Date
  isHidden?: boolean
}

export interface ReferencedNote {
  id: string
  noteId: string
  title: string
  icon?: string
}

export type SortOption = 'relevance' | 'recent' | 'alphabetical'
export type FilterOption = 'all' | 'sameFolder' | 'tagged' | 'recent'

export interface RelatedNotesTabProps {
  noteId: string
  relatedNotes: RelatedNote[]
  referencedNotes: ReferencedNote[]
  isLoading: boolean
  sortBy: SortOption
  filterBy: FilterOption
  onNoteClick: (noteId: string) => void
  onAddReference: (noteId: string) => void
  onRemoveReference: (noteId: string) => void
  onHideSuggestion: (noteId: string) => void
  onRefresh: () => void
  onSortChange: (sort: SortOption) => void
  onFilterChange: (filter: FilterOption) => void
  onShowMore: () => void
  hasMore?: boolean
  totalCount?: number
}

// Helper function to get percentage badge colors
export function getPercentageColors(percent: number): { text: string; bg: string } {
  if (percent >= 90) return { text: '#16a34a', bg: '#dcfce7' } // dark green
  if (percent >= 80) return { text: '#22c55e', bg: '#dcfce7' } // green
  if (percent >= 70) return { text: '#84cc16', bg: '#ecfccb' } // lime
  if (percent >= 60) return { text: '#eab308', bg: '#fef9c3' } // yellow
  if (percent >= 50) return { text: '#f97316', bg: '#ffedd5' } // orange
  return { text: '#ef4444', bg: '#fee2e2' } // red
}

// Helper function to get percentage label
export function getPercentageLabel(percent: number): string {
  if (percent >= 90) return 'Very High'
  if (percent >= 80) return 'High'
  if (percent >= 70) return 'Good'
  if (percent >= 60) return 'Medium'
  if (percent >= 50) return 'Low'
  return 'Very Low'
}

// Format relative time
export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? 's' : ''} ago`
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? 's' : ''} ago`
}
