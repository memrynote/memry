/**
 * Wiki-Link Utility Functions
 * Helper functions for wiki-link functionality
 */

export interface WikiLinkData {
  href: string // page ID
  title: string // display text
  exists: boolean // whether the page exists
}

/**
 * Format a page title for display in wiki-link
 */
export function formatWikiLinkTitle(title: string): string {
  return title.trim()
}

/**
 * Parse wiki-link syntax [[Page Name]] to extract title
 */
export function parseWikiLinkSyntax(text: string): string | null {
  const match = text.match(/^\[\[(.+?)\]\]$/)
  return match ? match[1].trim() : null
}

/**
 * Create wiki-link HTML for rendering
 */
export function createWikiLinkHTML(data: WikiLinkData): string {
  const classes = ['wiki-link']
  if (!data.exists) {
    classes.push('wiki-link-broken')
  }

  return `<span class="${classes.join(' ')}" data-wiki-link data-href="${data.href}" data-title="${data.title}">${data.title}</span>`
}

/**
 * Format relative time for "last edited" display
 */
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes} ${diffMinutes === 1 ? 'minute' : 'minutes'} ago`
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
  if (diffWeeks < 4) return `${diffWeeks} ${diffWeeks === 1 ? 'week' : 'weeks'} ago`
  if (diffMonths < 12) return `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`

  const diffYears = Math.floor(diffDays / 365)
  return `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`
}
