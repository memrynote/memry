/**
 * Layout Helper Functions
 * Utilities for manipulating the split layout tree
 */

import type { SplitLayout } from '@/contexts/tabs/types'

/**
 * Update ratio at a specific path in the layout tree
 */
export const updateRatioAtPath = (
  layout: SplitLayout,
  path: number[],
  newRatio: number
): SplitLayout => {
  // Path is empty - update this node
  if (path.length === 0) {
    if (layout.type !== 'leaf') {
      return { ...layout, ratio: newRatio }
    }
    return layout
  }

  // Can't traverse leaf nodes
  if (layout.type === 'leaf') return layout

  const [head, ...tail] = path

  if (head === 0) {
    return {
      ...layout,
      first: updateRatioAtPath(layout.first, tail, newRatio)
    }
  } else {
    return {
      ...layout,
      second: updateRatioAtPath(layout.second, tail, newRatio)
    }
  }
}

/**
 * Get all tab group IDs from the layout tree
 */
export const getGroupIdsFromLayout = (layout: SplitLayout): string[] => {
  if (layout.type === 'leaf') {
    return [layout.tabGroupId]
  }

  return [...getGroupIdsFromLayout(layout.first), ...getGroupIdsFromLayout(layout.second)]
}

/**
 * Find the path to a specific group in the layout tree
 */
export const findGroupPath = (
  layout: SplitLayout,
  groupId: string,
  currentPath: number[] = []
): number[] | null => {
  if (layout.type === 'leaf') {
    return layout.tabGroupId === groupId ? currentPath : null
  }

  const firstPath = findGroupPath(layout.first, groupId, [...currentPath, 0])
  if (firstPath) return firstPath

  return findGroupPath(layout.second, groupId, [...currentPath, 1])
}

/**
 * Remove a group from the layout tree
 * Returns the remaining layout or null if the group was the only one
 */
export const removeGroupFromLayout = (layout: SplitLayout, groupId: string): SplitLayout | null => {
  if (layout.type === 'leaf') {
    return layout.tabGroupId === groupId ? null : layout
  }

  const firstResult = removeGroupFromLayout(layout.first, groupId)
  const secondResult = removeGroupFromLayout(layout.second, groupId)

  // If one side is removed, return the other
  if (!firstResult) return secondResult
  if (!secondResult) return firstResult

  // Both sides remain
  return {
    ...layout,
    first: firstResult,
    second: secondResult
  }
}

/**
 * Insert a split at a specific group location
 */
export const insertSplitAtGroup = (
  layout: SplitLayout,
  targetGroupId: string,
  newGroupId: string,
  direction: 'horizontal',
  position: 'first' | 'second' = 'second'
): SplitLayout => {
  if (layout.type === 'leaf') {
    if (layout.tabGroupId === targetGroupId) {
      const existingLeaf: SplitLayout = { type: 'leaf', tabGroupId: targetGroupId }
      const newLeaf: SplitLayout = { type: 'leaf', tabGroupId: newGroupId }

      return {
        type: direction,
        ratio: 0.5,
        first: position === 'first' ? newLeaf : existingLeaf,
        second: position === 'first' ? existingLeaf : newLeaf
      }
    }
    return layout
  }

  return {
    ...layout,
    first: insertSplitAtGroup(layout.first, targetGroupId, newGroupId, direction, position),
    second: insertSplitAtGroup(layout.second, targetGroupId, newGroupId, direction, position)
  }
}

/**
 * Count total panes in the layout
 */
export const countPanes = (layout: SplitLayout): number => {
  if (layout.type === 'leaf') {
    return 1
  }
  return countPanes(layout.first) + countPanes(layout.second)
}

/**
 * Check if a specific group exists in the layout
 */
export const hasGroupInLayout = (layout: SplitLayout, groupId: string): boolean => {
  if (layout.type === 'leaf') {
    return layout.tabGroupId === groupId
  }
  return hasGroupInLayout(layout.first, groupId) || hasGroupInLayout(layout.second, groupId)
}

/**
 * Get sibling group ID (for navigating between splits)
 */
export const getSiblingGroupId = (layout: SplitLayout, groupId: string): string | null => {
  if (layout.type === 'leaf') return null

  // Check if groupId is in first child
  if (layout.first.type === 'leaf' && layout.first.tabGroupId === groupId) {
    // Return first group from second child
    return getGroupIdsFromLayout(layout.second)[0] ?? null
  }

  // Check if groupId is in second child
  if (layout.second.type === 'leaf' && layout.second.tabGroupId === groupId) {
    // Return first group from first child
    return getGroupIdsFromLayout(layout.first)[0] ?? null
  }

  // Recurse into children
  const siblingFromFirst = getSiblingGroupId(layout.first, groupId)
  if (siblingFromFirst) return siblingFromFirst

  return getSiblingGroupId(layout.second, groupId)
}
