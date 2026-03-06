/**
 * Tab Keyboard Shortcuts Hook
 * All keyboard shortcuts for tab management
 */

import { useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { useKeyboardShortcuts, type KeyboardShortcut } from './use-keyboard-shortcuts-base'

/**
 * Hook providing all tab-related keyboard shortcuts
 */
export const useTabKeyboardShortcuts = (): void => {
  const { state, dispatch, openTab, closeTab, pinTab, unpinTab, splitView, moveTabToNewSplit } =
    useTabs()

  const shortcuts = useMemo<KeyboardShortcut[]>(() => {
    const activeGroup = state.tabGroups[state.activeGroupId]
    const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId)

    return [
      // =====================================================================
      // TAB CRUD
      // =====================================================================

      // New tab (⌘T)
      {
        key: 't',
        modifiers: { meta: true },
        action: () =>
          openTab({
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          }),
        description: 'New tab'
      },

      // Close tab (⌘W)
      {
        key: 'w',
        modifiers: { meta: true },
        action: () => {
          if (activeTab) {
            closeTab(activeTab.id, state.activeGroupId)
          }
        },
        description: 'Close tab'
      },

      // Close all tabs (⌘⇧W)
      {
        key: 'w',
        modifiers: { meta: true, shift: true },
        action: () => {
          dispatch({
            type: 'CLOSE_ALL_TABS',
            payload: { groupId: state.activeGroupId }
          })
        },
        description: 'Close all tabs'
      },

      // =====================================================================
      // TAB NAVIGATION
      // =====================================================================

      // Next tab (Ctrl+Tab)
      {
        key: 'Tab',
        modifiers: { ctrl: true },
        action: () => {
          dispatch({
            type: 'GO_TO_NEXT_TAB',
            payload: { groupId: state.activeGroupId }
          })
        },
        description: 'Next tab'
      },

      // Previous tab (Ctrl+Shift+Tab)
      {
        key: 'Tab',
        modifiers: { ctrl: true, shift: true },
        action: () => {
          dispatch({
            type: 'GO_TO_PREVIOUS_TAB',
            payload: { groupId: state.activeGroupId }
          })
        },
        description: 'Previous tab'
      },

      // Go to tab 1-8 (⌘1-8)
      ...Array.from({ length: 8 }, (_, i) => ({
        key: String(i + 1),
        modifiers: { meta: true } as const,
        action: () => {
          dispatch({
            type: 'GO_TO_TAB_INDEX',
            payload: { index: i, groupId: state.activeGroupId }
          })
        },
        description: `Go to tab ${i + 1}`
      })),

      // Go to last tab (⌘9)
      {
        key: '9',
        modifiers: { meta: true },
        action: () => {
          if (activeGroup) {
            const lastIndex = activeGroup.tabs.length - 1
            dispatch({
              type: 'GO_TO_TAB_INDEX',
              payload: { index: lastIndex, groupId: state.activeGroupId }
            })
          }
        },
        description: 'Go to last tab'
      },

      // =====================================================================
      // TAB MODIFICATION
      // =====================================================================

      // Pin/Unpin tab (⌘⇧P)
      {
        key: 'p',
        modifiers: { meta: true, shift: true },
        action: () => {
          if (activeTab) {
            if (activeTab.isPinned) {
              unpinTab(activeTab.id, state.activeGroupId)
            } else {
              pinTab(activeTab.id, state.activeGroupId)
            }
          }
        },
        description: 'Pin/Unpin tab'
      },

      // Duplicate tab (⌘⇧D)
      {
        key: 'd',
        modifiers: { meta: true, shift: true },
        action: () => {
          if (activeTab) {
            openTab({
              type: activeTab.type,
              title: activeTab.title,
              icon: activeTab.icon,
              emoji: activeTab.emoji,
              path: activeTab.path,
              entityId: activeTab.entityId,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            })
          }
        },
        description: 'Duplicate tab'
      },

      // =====================================================================
      // SPLIT VIEW
      // =====================================================================

      // Split right (⌘\) - move active tab to new split
      {
        key: '\\',
        modifiers: { meta: true },
        action: () => {
          const group = state.tabGroups[state.activeGroupId]
          const activeTabId = group?.activeTabId
          if (activeTabId && group && group.tabs.length > 0) {
            moveTabToNewSplit(activeTabId, state.activeGroupId, 'right')
          }
        },
        description: 'Split right with active tab'
      },

      // Close split (⌘⌥W)
      {
        key: 'w',
        modifiers: { meta: true, alt: true },
        action: () => {
          if (Object.keys(state.tabGroups).length > 1) {
            dispatch({
              type: 'CLOSE_SPLIT',
              payload: { groupId: state.activeGroupId }
            })
          }
        },
        description: 'Close split pane',
        when: () => Object.keys(state.tabGroups).length > 1
      }
    ]
  }, [
    state.tabGroups,
    state.activeGroupId,
    dispatch,
    openTab,
    closeTab,
    pinTab,
    unpinTab,
    splitView
  ])

  useKeyboardShortcuts(shortcuts)
}

export default useTabKeyboardShortcuts
