import type { SplitDirection, SplitLayout } from '@/contexts/tabs/types'

export const updateRatioAtPath = (
  layout: SplitLayout,
  path: number[],
  newRatio: number
): SplitLayout => {
  if (path.length === 0) {
    if (layout.type === 'split') {
      return { ...layout, ratio: newRatio }
    }
    return layout
  }

  if (layout.type === 'leaf') return layout

  const [head, ...tail] = path

  if (head === 0) {
    return { ...layout, first: updateRatioAtPath(layout.first, tail, newRatio) }
  }
  return { ...layout, second: updateRatioAtPath(layout.second, tail, newRatio) }
}

export const getGroupIdsFromLayout = (layout: SplitLayout): string[] => {
  if (layout.type === 'leaf') return [layout.tabGroupId]
  return [...getGroupIdsFromLayout(layout.first), ...getGroupIdsFromLayout(layout.second)]
}

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

export const removeGroupFromLayout = (layout: SplitLayout, groupId: string): SplitLayout | null => {
  if (layout.type === 'leaf') {
    return layout.tabGroupId === groupId ? null : layout
  }

  const firstResult = removeGroupFromLayout(layout.first, groupId)
  const secondResult = removeGroupFromLayout(layout.second, groupId)

  if (!firstResult) return secondResult
  if (!secondResult) return firstResult

  return { ...layout, first: firstResult, second: secondResult }
}

export const insertSplitAtGroup = (
  layout: SplitLayout,
  targetGroupId: string,
  newGroupId: string,
  direction: SplitDirection,
  position: 'first' | 'second' = 'second'
): SplitLayout => {
  if (layout.type === 'leaf') {
    if (layout.tabGroupId === targetGroupId) {
      const existingLeaf: SplitLayout = { type: 'leaf', tabGroupId: targetGroupId }
      const newLeaf: SplitLayout = { type: 'leaf', tabGroupId: newGroupId }

      return {
        type: 'split',
        direction,
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

export const countPanes = (layout: SplitLayout): number => {
  if (layout.type === 'leaf') return 1
  return countPanes(layout.first) + countPanes(layout.second)
}

export const hasGroupInLayout = (layout: SplitLayout, groupId: string): boolean => {
  if (layout.type === 'leaf') return layout.tabGroupId === groupId
  return hasGroupInLayout(layout.first, groupId) || hasGroupInLayout(layout.second, groupId)
}

export const getSiblingGroupId = (layout: SplitLayout, groupId: string): string | null => {
  if (layout.type === 'leaf') return null

  if (layout.first.type === 'leaf' && layout.first.tabGroupId === groupId) {
    return getGroupIdsFromLayout(layout.second)[0] ?? null
  }

  if (layout.second.type === 'leaf' && layout.second.tabGroupId === groupId) {
    return getGroupIdsFromLayout(layout.first)[0] ?? null
  }

  const siblingFromFirst = getSiblingGroupId(layout.first, groupId)
  if (siblingFromFirst) return siblingFromFirst

  return getSiblingGroupId(layout.second, groupId)
}
