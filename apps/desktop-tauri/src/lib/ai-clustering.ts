import type { InboxItemListItem } from '@/types'
import { extractDomain } from '@/lib/inbox-utils'

// Type alias for convenience
type InboxItem = InboxItemListItem

export interface ClusterSuggestion {
  items: InboxItem[]
  reason: string
}

// Keywords that indicate design-related content
const DESIGN_KEYWORDS = ['design', 'system', 'token', 'component', 'ui', 'ux', 'figma', 'style']

// Keywords that indicate technical content
const TECH_KEYWORDS = [
  'api',
  'code',
  'architecture',
  'react',
  'typescript',
  'javascript',
  'frontend',
  'backend'
]

// Keywords that indicate research/reading content
const READING_KEYWORDS = ['article', 'book', 'reading', 'research', 'study', 'paper']

/**
 * Detects clusters of related items based on the current selection.
 * Returns a suggestion object with related items and a human-readable reason.
 */
export const detectClusters = (
  selectedItems: InboxItem[],
  allItems: InboxItem[]
): ClusterSuggestion | null => {
  if (selectedItems.length === 0) return null

  // Get unselected items
  const selectedIds = new Set(selectedItems.map((i) => i.id))
  const unselectedItems = allItems.filter((item) => !selectedIds.has(item.id))

  if (unselectedItems.length === 0) return null

  // Try different clustering strategies and return the first match

  // 1. Same content type clustering
  const typeCluster = findSameTypeCluster(selectedItems, unselectedItems)
  if (typeCluster && typeCluster.items.length > 0) {
    return typeCluster
  }

  // 2. Same domain clustering (for links)
  const domainCluster = findSameDomainCluster(selectedItems, unselectedItems)
  if (domainCluster && domainCluster.items.length > 0) {
    return domainCluster
  }

  // 3. Topic/keyword clustering
  const topicCluster = findTopicCluster(selectedItems, unselectedItems)
  if (topicCluster && topicCluster.items.length > 0) {
    return topicCluster
  }

  return null
}

/**
 * Find items of the same type as the selected items
 */
const findSameTypeCluster = (
  selectedItems: InboxItem[],
  unselectedItems: InboxItem[]
): ClusterSuggestion | null => {
  // Get unique types from selection
  const selectedTypes = new Set(selectedItems.map((i) => i.type))

  // Only suggest if all selected items are the same type
  if (selectedTypes.size !== 1) return null

  const type = selectedItems[0].type
  const sameTypeItems = unselectedItems.filter((item) => item.type === type)

  if (sameTypeItems.length === 0) return null

  const typeLabels: Record<string, string> = {
    link: 'links',
    note: 'notes',
    image: 'images',
    voice: 'voice memos'
  }

  return {
    items: sameTypeItems,
    reason: `${sameTypeItems.length} more ${typeLabels[type] || type}`
  }
}

/**
 * Find items from the same domain (for links)
 */
const findSameDomainCluster = (
  selectedItems: InboxItem[],
  unselectedItems: InboxItem[]
): ClusterSuggestion | null => {
  // Get domains from selected links
  const selectedLinks = selectedItems.filter((i) => i.type === 'link' && i.sourceUrl)
  if (selectedLinks.length === 0) return null

  const selectedDomains = new Set(selectedLinks.map((i) => extractDomain(i.sourceUrl!)))

  // If multiple domains selected, skip this clustering
  if (selectedDomains.size > 2) return null

  // Find unselected items from same domains
  const sameDomainItems = unselectedItems.filter((item) => {
    if (item.type !== 'link' || !item.sourceUrl) return false
    return selectedDomains.has(extractDomain(item.sourceUrl))
  })

  if (sameDomainItems.length === 0) return null

  // Get the most common domain for the message
  const domainCounts = new Map<string, number>()
  sameDomainItems.forEach((item) => {
    const domain = extractDomain(item.sourceUrl!)
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1)
  })

  const topDomain = Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]

  return {
    items: sameDomainItems,
    reason: `${sameDomainItems.length} more from ${topDomain}`
  }
}

/**
 * Find items with similar topics based on title keywords
 */
const findTopicCluster = (
  selectedItems: InboxItem[],
  unselectedItems: InboxItem[]
): ClusterSuggestion | null => {
  // Extract keywords from selected item titles
  const selectedTitleWords = new Set<string>()
  selectedItems.forEach((item) => {
    const words = item.title.toLowerCase().split(/\s+/)
    words.forEach((word) => {
      if (word.length > 3) {
        selectedTitleWords.add(word)
      }
    })
  })

  // Check for design-related cluster
  const hasDesignKeywords = DESIGN_KEYWORDS.some((kw) =>
    Array.from(selectedTitleWords).some((word) => word.includes(kw))
  )

  if (hasDesignKeywords) {
    const designItems = unselectedItems.filter((item) =>
      DESIGN_KEYWORDS.some((kw) => item.title.toLowerCase().includes(kw))
    )

    if (designItems.length > 0) {
      return {
        items: designItems,
        reason: `${designItems.length} more items about design`
      }
    }
  }

  // Check for tech-related cluster
  const hasTechKeywords = TECH_KEYWORDS.some((kw) =>
    Array.from(selectedTitleWords).some((word) => word.includes(kw))
  )

  if (hasTechKeywords) {
    const techItems = unselectedItems.filter((item) =>
      TECH_KEYWORDS.some((kw) => item.title.toLowerCase().includes(kw))
    )

    if (techItems.length > 0) {
      return {
        items: techItems,
        reason: `${techItems.length} more items about development`
      }
    }
  }

  // Generic keyword matching
  const relatedItems = unselectedItems.filter((item) => {
    const itemWords = item.title.toLowerCase().split(/\s+/)
    return itemWords.some((word) => word.length > 4 && selectedTitleWords.has(word))
  })

  if (relatedItems.length > 0) {
    return {
      items: relatedItems,
      reason: `${relatedItems.length} more related items`
    }
  }

  return null
}

/**
 * Generate a unique key for a cluster suggestion (for dismissal tracking)
 */
export const getClusterKey = (suggestion: ClusterSuggestion): string => {
  const itemIds = suggestion.items
    .map((i) => i.id)
    .sort()
    .join(',')
  return `${suggestion.reason}:${itemIds}`
}
