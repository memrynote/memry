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
  const {
    state,
    dispatch,
    openTab,
    closeTab,
    reopenClosedTab,
    pinTab,
    unpinTab,
    splitView,
    navBack,
    navForward
  } = useTabs()

  const shortcuts = useMemo<KeyboardShortcut[]>(() => {
    const activeGroup = state.tabGroups[state.activeGroupId]
    const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId)

    return [
      // =====================================================================
      // TAB CRUD
      // =====================================================================

      // New tab (⌘T) — opens the new-tab dropdown menu
      {
        key: 't',
        modifiers: { meta: true },
        action: () => {
          window.dispatchEvent(new CustomEvent('memry:new-tab-menu'))
        },
        description: 'New tab'
      },

      // Close tab (⌘W) — if only inbox remains, close the window
      {
        key: 'w',
        modifiers: { meta: true },
        action: () => {
          if (!activeTab) return

          const isOnlyTab = activeGroup?.tabs.length === 1
          const isSingleGroup = Object.keys(state.tabGroups).length === 1
          const isInboxTab = activeTab.type === 'inbox'

          if (isOnlyTab && isSingleGroup && isInboxTab) {
            window.api.windowClose()
          } else {
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

      // Reopen closed tab (⌘⇧T) — like Chrome
      {
        key: 't',
        modifiers: { meta: true, shift: true },
        action: () => {
          reopenClosedTab()
        },
        description: 'Reopen closed tab'
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

      // Navigate back in tab history (⌘[)
      {
        key: '[',
        modifiers: { meta: true },
        action: () => navBack(state.activeGroupId),
        description: 'Navigate back'
      },

      // Navigate forward in tab history (⌘])
      {
        key: ']',
        modifiers: { meta: true },
        action: () => navForward(state.activeGroupId),
        description: 'Navigate forward'
      },

      // NOTE: ⌘1-9 are intentionally NOT bound here. They now open the Nth
      // sidebar section (see app-sidebar.tsx / useModifierHeld). Ctrl+Tab and
      // Ctrl+Shift+Tab remain the way to cycle open tabs.

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

      // Split right (⌘\)
      {
        key: '\\',
        modifiers: { meta: true },
        action: () => {
          splitView('horizontal', state.activeGroupId)
        },
        description: 'Split right'
      },

      // Split down (⌘⇧\)
      {
        key: '\\',
        modifiers: { meta: true, shift: true },
        action: () => {
          splitView('vertical', state.activeGroupId)
        },
        description: 'Split down'
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
    reopenClosedTab,
    pinTab,
    unpinTab,
    splitView,
    navBack,
    navForward
  ])

  useKeyboardShortcuts(shortcuts)
}

export default useTabKeyboardShortcuts
