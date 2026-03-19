/**
 * Layout Presets
 * Common layout configurations for quick access
 */

import type { TabSystemState, TabGroup, Tab } from '@/contexts/tabs/types'
import { generateId, createDefaultTab } from '@/contexts/tabs/helpers'

// =============================================================================
// TYPES
// =============================================================================

export type LayoutPreset =
  | 'single'
  | 'two-columns'
  | 'two-rows'
  | 'three-columns'
  | 'grid-2x2'
  | 'main-sidebar'

export interface LayoutPresetConfig {
  id: LayoutPreset
  label: string
  description: string
}

// =============================================================================
// PRESET DEFINITIONS
// =============================================================================

export const layoutPresets: LayoutPresetConfig[] = [
  { id: 'single', label: 'Single', description: 'Single pane' },
  { id: 'two-columns', label: 'Two Columns', description: 'Side by side' },
  { id: 'two-rows', label: 'Two Rows', description: 'Top and bottom' },
  { id: 'three-columns', label: 'Three Columns', description: 'Three panes' },
  { id: 'grid-2x2', label: 'Grid 2×2', description: 'Four-pane grid' },
  { id: 'main-sidebar', label: 'Main + Side', description: '70/30 split' }
]

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a tab group with tabs
 */
const createGroup = (id: string, tabs: Tab[], isActive: boolean): TabGroup => {
  const groupTabs = tabs.length > 0 ? tabs : [createDefaultTab()]
  return {
    id,
    tabs: groupTabs,
    activeTabId: groupTabs[0]?.id ?? null,
    isActive
  }
}

/**
 * Split array into chunks
 */
const splitArray = <T>(array: T[], chunks: number = 2): T[][] => {
  const result: T[][] = Array.from({ length: chunks }, () => [])
  array.forEach((item, index) => {
    result[index % chunks].push(item)
  })
  return result
}

// =============================================================================
// APPLY PRESET
// =============================================================================

/**
 * Apply a layout preset to the current state
 */
export const applyLayoutPreset = (
  state: TabSystemState,
  preset: LayoutPreset
): Partial<TabSystemState> => {
  // Collect all existing tabs
  const allTabs = Object.values(state.tabGroups).flatMap((g) => g.tabs)

  switch (preset) {
    case 'single': {
      const groupId = generateId()
      const group = createGroup(groupId, allTabs, true)

      return {
        tabGroups: { [groupId]: group },
        layout: { type: 'leaf', tabGroupId: groupId },
        activeGroupId: groupId
      }
    }

    case 'two-columns': {
      const group1Id = generateId()
      const group2Id = generateId()
      const [firstTabs, secondTabs] = splitArray(allTabs, 2)

      return {
        tabGroups: {
          [group1Id]: createGroup(group1Id, firstTabs, true),
          [group2Id]: createGroup(group2Id, secondTabs, false)
        },
        layout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: group1Id },
          second: { type: 'leaf', tabGroupId: group2Id }
        },
        activeGroupId: group1Id
      }
    }

    case 'two-rows': {
      const topId = generateId()
      const bottomId = generateId()
      const [topTabs, bottomTabs] = splitArray(allTabs, 2)

      return {
        tabGroups: {
          [topId]: createGroup(topId, topTabs, true),
          [bottomId]: createGroup(bottomId, bottomTabs, false)
        },
        layout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', tabGroupId: topId },
          second: { type: 'leaf', tabGroupId: bottomId }
        },
        activeGroupId: topId
      }
    }

    case 'three-columns': {
      const group1Id = generateId()
      const group2Id = generateId()
      const group3Id = generateId()
      const chunks = splitArray(allTabs, 3)

      return {
        tabGroups: {
          [group1Id]: createGroup(group1Id, chunks[0], true),
          [group2Id]: createGroup(group2Id, chunks[1], false),
          [group3Id]: createGroup(group3Id, chunks[2], false)
        },
        layout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.33,
          first: { type: 'leaf', tabGroupId: group1Id },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', tabGroupId: group2Id },
            second: { type: 'leaf', tabGroupId: group3Id }
          }
        },
        activeGroupId: group1Id
      }
    }

    case 'grid-2x2': {
      const tlId = generateId()
      const trId = generateId()
      const blId = generateId()
      const brId = generateId()
      const chunks = splitArray(allTabs, 4)

      return {
        tabGroups: {
          [tlId]: createGroup(tlId, chunks[0], true),
          [trId]: createGroup(trId, chunks[1], false),
          [blId]: createGroup(blId, chunks[2], false),
          [brId]: createGroup(brId, chunks[3], false)
        },
        layout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', tabGroupId: tlId },
            second: { type: 'leaf', tabGroupId: trId }
          },
          second: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', tabGroupId: blId },
            second: { type: 'leaf', tabGroupId: brId }
          }
        },
        activeGroupId: tlId
      }
    }

    case 'main-sidebar': {
      const mainId = generateId()
      const sidebarId = generateId()

      return {
        tabGroups: {
          [mainId]: createGroup(mainId, allTabs, true),
          [sidebarId]: createGroup(sidebarId, [], false)
        },
        layout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.7,
          first: { type: 'leaf', tabGroupId: mainId },
          second: { type: 'leaf', tabGroupId: sidebarId }
        },
        activeGroupId: mainId
      }
    }

    default:
      return {}
  }
}
