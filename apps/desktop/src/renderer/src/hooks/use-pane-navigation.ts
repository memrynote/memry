/**
 * Pane Navigation Helpers
 * Utilities for navigating between split panes based on layout
 */

import type { SplitLayout } from '@/contexts/tabs/types'

// =============================================================================
// TYPES
// =============================================================================

export interface GroupPosition {
  /** Center X position (0-1) */
  centerX: number
  /** Center Y position (0-1) */
  centerY: number
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Calculate center positions of all groups based on layout tree
 * Returns positions normalized to 0-1 range
 */
export const calculateGroupPositions = (
  layout: SplitLayout,
  bounds: Bounds = { x: 0, y: 0, width: 1, height: 1 }
): Record<string, GroupPosition> => {
  // Leaf node - return center of bounds
  if (layout.type === 'leaf') {
    return {
      [layout.tabGroupId]: {
        centerX: bounds.x + bounds.width / 2,
        centerY: bounds.y + bounds.height / 2
      }
    }
  }

  // Split node - calculate bounds for each child
  const isHorizontal = layout.type === 'horizontal'
  const firstSize = layout.ratio
  const secondSize = 1 - layout.ratio

  const firstBounds: Bounds = isHorizontal
    ? {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width * firstSize,
        height: bounds.height
      }
    : {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height * firstSize
      }

  const secondBounds: Bounds = isHorizontal
    ? {
        x: bounds.x + bounds.width * firstSize,
        y: bounds.y,
        width: bounds.width * secondSize,
        height: bounds.height
      }
    : {
        x: bounds.x,
        y: bounds.y + bounds.height * firstSize,
        width: bounds.width,
        height: bounds.height * secondSize
      }

  // Recursively get positions from children
  return {
    ...calculateGroupPositions(layout.first, firstBounds),
    ...calculateGroupPositions(layout.second, secondBounds)
  }
}

/**
 * Find the nearest group in a specific direction
 */
export const findGroupInDirection = (
  currentGroupId: string,
  direction: 'left' | 'right' | 'up' | 'down',
  groupPositions: Record<string, GroupPosition>
): string | null => {
  const currentPosition = groupPositions[currentGroupId]
  if (!currentPosition) return null

  let targetGroupId: string | null = null
  let minDistance = Infinity

  for (const [groupId, position] of Object.entries(groupPositions)) {
    if (groupId === currentGroupId) continue

    let isInDirection = false
    let distance = 0

    switch (direction) {
      case 'left':
        isInDirection = position.centerX < currentPosition.centerX
        distance = currentPosition.centerX - position.centerX
        break
      case 'right':
        isInDirection = position.centerX > currentPosition.centerX
        distance = position.centerX - currentPosition.centerX
        break
      case 'up':
        isInDirection = position.centerY < currentPosition.centerY
        distance = currentPosition.centerY - position.centerY
        break
      case 'down':
        isInDirection = position.centerY > currentPosition.centerY
        distance = position.centerY - currentPosition.centerY
        break
    }

    if (isInDirection && distance < minDistance) {
      minDistance = distance
      targetGroupId = groupId
    }
  }

  return targetGroupId
}

/**
 * Get the order of groups based on their position (left-to-right, top-to-bottom)
 */
export const getGroupOrder = (layout: SplitLayout): string[] => {
  const positions = calculateGroupPositions(layout)

  return Object.entries(positions)
    .sort((a, b) => {
      // Sort by Y first (top to bottom), then by X (left to right)
      const yDiff = a[1].centerY - b[1].centerY
      if (Math.abs(yDiff) > 0.1) return yDiff
      return a[1].centerX - b[1].centerX
    })
    .map(([groupId]) => groupId)
}
