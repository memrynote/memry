// ============================================================================
// FILING UTILITIES
// ============================================================================
// Helper functions for folder/tag operations, searching, and AI suggestions.

import type {
  Folder,
  Tag,
  TagColor,
  TagColorConfig,
  FolderColorConfig,
  FolderSuggestion,
  AISuggestions,
  RecentFolders,
  RecentTags,
} from '@/data/filing-types'
import {
  TAG_COLORS,
  FOLDER_COLORS,
  DEFAULT_TAG_COLOR,
  DEFAULT_FOLDER_COLOR,
  RECENT_LIMITS,
  AI_CONFIDENCE_THRESHOLDS,
} from '@/data/filing-types'
import type { InboxItem } from '@/data/inbox-types'

// ============================================================================
// FOLDER UTILITIES
// ============================================================================

/**
 * Get the full path string for a folder.
 * Returns "Parent / Child / Grandchild" format.
 */
export function getFolderPath(folders: Folder[], folderId: string): string {
  const ancestors = getFolderAncestors(folders, folderId)
  const folder = folders.find((f) => f.id === folderId)

  if (!folder) return ''

  return [...ancestors, folder].map((f) => f.name).join(' / ')
}

/**
 * Get direct children of a folder.
 */
export function getFolderChildren(
  folders: Folder[],
  parentId: string | null
): Folder[] {
  return folders.filter((f) => f.parentId === parentId)
}

/**
 * Get all ancestor folders (from root to immediate parent).
 */
export function getFolderAncestors(
  folders: Folder[],
  folderId: string
): Folder[] {
  const ancestors: Folder[] = []
  const folderMap = new Map(folders.map((f) => [f.id, f]))

  let current = folderMap.get(folderId)

  while (current?.parentId) {
    const parent = folderMap.get(current.parentId)
    if (parent) {
      ancestors.unshift(parent)
      current = parent
    } else {
      break
    }
  }

  return ancestors
}

/**
 * Get all descendant folders (children, grandchildren, etc).
 */
export function getFolderDescendants(
  folders: Folder[],
  folderId: string
): Folder[] {
  const descendants: Folder[] = []
  const queue = [folderId]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const children = folders.filter((f) => f.parentId === currentId)

    children.forEach((child) => {
      descendants.push(child)
      queue.push(child.id)
    })
  }

  return descendants
}

/**
 * Search folders by name or path.
 * Returns folders matching the query, sorted by relevance.
 */
export function searchFolders(folders: Folder[], query: string): Folder[] {
  if (!query.trim()) return folders

  const normalizedQuery = query.toLowerCase().trim()

  return folders
    .filter((folder) => {
      const nameMatch = folder.name.toLowerCase().includes(normalizedQuery)
      const pathMatch = folder.path.toLowerCase().includes(normalizedQuery)
      return nameMatch || pathMatch
    })
    .sort((a, b) => {
      // Prioritize exact name matches
      const aExact = a.name.toLowerCase() === normalizedQuery
      const bExact = b.name.toLowerCase() === normalizedQuery
      if (aExact && !bExact) return -1
      if (!aExact && bExact) return 1

      // Then name starts with query
      const aStarts = a.name.toLowerCase().startsWith(normalizedQuery)
      const bStarts = b.name.toLowerCase().startsWith(normalizedQuery)
      if (aStarts && !bStarts) return -1
      if (!aStarts && bStarts) return 1

      // Then by item count (more items = more relevant)
      return b.itemCount - a.itemCount
    })
}

/**
 * Get folder by ID.
 */
export function getFolderById(
  folders: Folder[],
  folderId: string
): Folder | undefined {
  return folders.find((f) => f.id === folderId)
}

/**
 * Get root folders (no parent).
 */
export function getRootFolders(folders: Folder[]): Folder[] {
  return folders.filter((f) => f.parentId === null)
}

/**
 * Get folder color configuration.
 */
export function getFolderColor(folder: Folder): FolderColorConfig {
  return FOLDER_COLORS[folder.color ?? DEFAULT_FOLDER_COLOR]
}

/**
 * Calculate folder depth in hierarchy.
 */
export function getFolderDepth(folders: Folder[], folderId: string): number {
  return getFolderAncestors(folders, folderId).length
}

// ============================================================================
// TAG UTILITIES
// ============================================================================

/**
 * Find a tag by name (case-insensitive).
 */
export function getTagByName(tags: Tag[], name: string): Tag | undefined {
  const normalizedName = name.toLowerCase().trim()
  return tags.find((t) => t.name.toLowerCase() === normalizedName)
}

/**
 * Get tag by ID.
 */
export function getTagById(tags: Tag[], tagId: string): Tag | undefined {
  return tags.find((t) => t.id === tagId)
}

/**
 * Search tags by name.
 */
export function searchTags(tags: Tag[], query: string): Tag[] {
  if (!query.trim()) return tags

  const normalizedQuery = query.toLowerCase().trim()

  return tags
    .filter((tag) => tag.name.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      // Prioritize exact matches
      const aExact = a.name.toLowerCase() === normalizedQuery
      const bExact = b.name.toLowerCase() === normalizedQuery
      if (aExact && !bExact) return -1
      if (!aExact && bExact) return 1

      // Then by usage count
      return b.usageCount - a.usageCount
    })
}

/**
 * Get tag color configuration.
 */
export function getTagColor(tag: Tag): TagColorConfig {
  return TAG_COLORS[tag.color]
}

/**
 * Get tag color config by color name.
 */
export function getTagColorByName(color: TagColor): TagColorConfig {
  return TAG_COLORS[color]
}

/**
 * Sort tags by usage count (most used first).
 */
export function sortTagsByUsage(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) => b.usageCount - a.usageCount)
}

/**
 * Create a new tag object.
 */
export function createTag(
  name: string,
  color: TagColor = DEFAULT_TAG_COLOR
): Omit<Tag, 'id'> {
  return {
    name: name.toLowerCase().trim(),
    color,
    usageCount: 0,
    createdAt: new Date(),
  }
}

/**
 * Validate tag name.
 */
export function isValidTagName(name: string): boolean {
  const trimmed = name.trim()
  // At least 1 char, no more than 30, no special characters except hyphen/underscore
  return (
    trimmed.length >= 1 &&
    trimmed.length <= 30 &&
    /^[a-zA-Z0-9_-]+$/.test(trimmed)
  )
}

// ============================================================================
// FILING OPERATIONS
// ============================================================================

/**
 * File an item to a folder.
 * Returns a new item with updated folderId and filedAt.
 */
export function fileItem<T extends InboxItem>(item: T, folderId: string): T {
  return {
    ...item,
    folderId,
    filedAt: new Date(),
  }
}

/**
 * Unfile an item (move back to inbox).
 */
export function unfileItem<T extends InboxItem>(item: T): T {
  return {
    ...item,
    folderId: null,
    filedAt: null,
  }
}

/**
 * Add a tag to an item.
 */
export function addTagToItem<T extends InboxItem>(
  item: T,
  tagId: string
): T {
  if (item.tagIds.includes(tagId)) {
    return item // Already has tag
  }
  return {
    ...item,
    tagIds: [...item.tagIds, tagId],
  }
}

/**
 * Remove a tag from an item.
 */
export function removeTagFromItem<T extends InboxItem>(
  item: T,
  tagId: string
): T {
  return {
    ...item,
    tagIds: item.tagIds.filter((id) => id !== tagId),
  }
}

/**
 * Set all tags on an item.
 */
export function setItemTags<T extends InboxItem>(
  item: T,
  tagIds: string[]
): T {
  return {
    ...item,
    tagIds,
  }
}

/**
 * Check if an item is filed.
 */
export function isItemFiled(item: InboxItem): boolean {
  return item.folderId !== null
}

/**
 * Check if an item has a specific tag.
 */
export function itemHasTag(item: InboxItem, tagId: string): boolean {
  return item.tagIds.includes(tagId)
}

// ============================================================================
// RECENT TRACKING
// ============================================================================

/**
 * Add a folder to recent list.
 * Moves to front if already present, caps at limit.
 */
export function addToRecentFolders(
  recent: RecentFolders,
  folderId: string
): RecentFolders {
  const filtered = recent.folderIds.filter((id) => id !== folderId)
  return {
    folderIds: [folderId, ...filtered].slice(0, RECENT_LIMITS.FOLDERS),
    updatedAt: new Date(),
  }
}

/**
 * Add a tag to recent list.
 */
export function addToRecentTags(
  recent: RecentTags,
  tagId: string
): RecentTags {
  const filtered = recent.tagIds.filter((id) => id !== tagId)
  return {
    tagIds: [tagId, ...filtered].slice(0, RECENT_LIMITS.TAGS),
    updatedAt: new Date(),
  }
}

/**
 * Get recent folders as Folder objects.
 */
export function getRecentFolderObjects(
  folders: Folder[],
  recentIds: string[]
): Folder[] {
  return recentIds
    .map((id) => folders.find((f) => f.id === id))
    .filter((f): f is Folder => f !== undefined)
}

/**
 * Get recent tags as Tag objects.
 */
export function getRecentTagObjects(
  tags: Tag[],
  recentIds: string[]
): Tag[] {
  return recentIds
    .map((id) => tags.find((t) => t.id === id))
    .filter((t): t is Tag => t !== undefined)
}

// ============================================================================
// AI SUGGESTION UTILITIES
// ============================================================================

/**
 * Generate mock folder suggestions for an item.
 * In production, this would call an AI service.
 */
export function getMockSuggestions(
  item: InboxItem,
  folders: Folder[],
  allItems: InboxItem[]
): AISuggestions {
  const suggestions: FolderSuggestion[] = []

  // Strategy 1: Match by domain for links
  if (item.type === 'link') {
    const linkItem = item as InboxItem & { domain?: string }
    if (linkItem.domain) {
      // Find folders with other items from same domain
      const samedomainItems = allItems.filter(
        (i) =>
          i.id !== item.id &&
          i.type === 'link' &&
          (i as InboxItem & { domain?: string }).domain === linkItem.domain &&
          i.folderId !== null
      )

      const folderCounts = new Map<string, string[]>()
      samedomainItems.forEach((i) => {
        const existing = folderCounts.get(i.folderId!) || []
        folderCounts.set(i.folderId!, [...existing, i.id])
      })

      folderCounts.forEach((itemIds, folderId) => {
        const folder = folders.find((f) => f.id === folderId)
        if (folder) {
          suggestions.push({
            folderId,
            confidence: Math.min(95, 60 + itemIds.length * 10),
            reason: `${itemIds.length} similar ${itemIds.length === 1 ? 'link' : 'links'} from ${linkItem.domain}`,
            similarItemIds: itemIds,
          })
        }
      })
    }
  }

  // Strategy 2: Match by shared tags
  if (item.tagIds.length > 0) {
    const itemsWithSharedTags = allItems.filter(
      (i) =>
        i.id !== item.id &&
        i.folderId !== null &&
        i.tagIds.some((t) => item.tagIds.includes(t))
    )

    const folderTagCounts = new Map<string, { count: number; items: string[] }>()
    itemsWithSharedTags.forEach((i) => {
      const sharedCount = i.tagIds.filter((t) => item.tagIds.includes(t)).length
      const existing = folderTagCounts.get(i.folderId!) || { count: 0, items: [] }
      folderTagCounts.set(i.folderId!, {
        count: existing.count + sharedCount,
        items: [...existing.items, i.id],
      })
    })

    folderTagCounts.forEach((data, folderId) => {
      const folder = folders.find((f) => f.id === folderId)
      if (folder && !suggestions.some((s) => s.folderId === folderId)) {
        suggestions.push({
          folderId,
          confidence: Math.min(85, 40 + data.count * 8),
          reason: `Items with similar tags`,
          similarItemIds: data.items.slice(0, 3),
        })
      }
    })
  }

  // Strategy 3: Match by item type
  const sameTypeItems = allItems.filter(
    (i) =>
      i.id !== item.id &&
      i.type === item.type &&
      i.folderId !== null
  )

  const typeFolderCounts = new Map<string, string[]>()
  sameTypeItems.forEach((i) => {
    const existing = typeFolderCounts.get(i.folderId!) || []
    typeFolderCounts.set(i.folderId!, [...existing, i.id])
  })

  typeFolderCounts.forEach((itemIds, folderId) => {
    if (itemIds.length >= 3 && !suggestions.some((s) => s.folderId === folderId)) {
      const folder = folders.find((f) => f.id === folderId)
      if (folder) {
        suggestions.push({
          folderId,
          confidence: Math.min(70, 30 + itemIds.length * 5),
          reason: `Contains ${itemIds.length} similar ${item.type}s`,
          similarItemIds: itemIds.slice(0, 3),
        })
      }
    }
  })

  // Sort by confidence
  suggestions.sort((a, b) => b.confidence - a.confidence)

  // Determine primary and alternatives
  const primary =
    suggestions.length > 0 && suggestions[0].confidence >= AI_CONFIDENCE_THRESHOLDS.MEDIUM
      ? suggestions[0]
      : null

  const alternatives = suggestions
    .slice(primary ? 1 : 0)
    .filter((s) => s.confidence >= AI_CONFIDENCE_THRESHOLDS.LOW)
    .slice(0, 3)

  return {
    primary,
    alternatives,
    generatedAt: new Date(),
  }
}

/**
 * Check if suggestions should be shown for an item.
 */
export function hasSuggestions(suggestions: AISuggestions): boolean {
  return suggestions.primary !== null || suggestions.alternatives.length > 0
}

/**
 * Get the best suggestion if it's high confidence.
 */
export function getHighConfidenceSuggestion(
  suggestions: AISuggestions
): FolderSuggestion | null {
  if (
    suggestions.primary &&
    suggestions.primary.confidence >= AI_CONFIDENCE_THRESHOLDS.HIGH
  ) {
    return suggestions.primary
  }
  return null
}

// ============================================================================
// LOCAL STORAGE HELPERS
// ============================================================================

const STORAGE_KEYS = {
  RECENT_FOLDERS: 'memry:recent-folders',
  RECENT_TAGS: 'memry:recent-tags',
} as const

/**
 * Save recent folders to localStorage.
 */
export function saveRecentFolders(recent: RecentFolders): void {
  try {
    localStorage.setItem(STORAGE_KEYS.RECENT_FOLDERS, JSON.stringify(recent))
  } catch {
    // Ignore storage errors
  }
}

/**
 * Load recent folders from localStorage.
 */
export function loadRecentFolders(): RecentFolders {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.RECENT_FOLDERS)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        folderIds: parsed.folderIds || [],
        updatedAt: new Date(parsed.updatedAt),
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { folderIds: [], updatedAt: new Date() }
}

/**
 * Save recent tags to localStorage.
 */
export function saveRecentTags(recent: RecentTags): void {
  try {
    localStorage.setItem(STORAGE_KEYS.RECENT_TAGS, JSON.stringify(recent))
  } catch {
    // Ignore storage errors
  }
}

/**
 * Load recent tags from localStorage.
 */
export function loadRecentTags(): RecentTags {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.RECENT_TAGS)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        tagIds: parsed.tagIds || [],
        updatedAt: new Date(parsed.updatedAt),
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { tagIds: [], updatedAt: new Date() }
}
