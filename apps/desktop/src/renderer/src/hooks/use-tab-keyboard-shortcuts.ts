/**
 * Tab Keyboard Shortcuts Hook
 * All keyboard shortcuts for tab management
 */

import { useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { isLastHomeTab } from '@/contexts/tabs/helpers'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { useKeyboardShortcuts, type KeyboardShortcut } from './use-keyboard-shortcuts-base'

/**
 * Hook providing all tab-related keyboard shortcuts
 *
 * Chords listed in Settings → Shortcuts are read from the binding store so a
 * rebind applies here; the rest (⌘T, ⌘⇧W, ⌘⇧P, ⌘⇧D, ⌘\) are fixed.
 */
export const useTabKeyboardShortcuts = (): void => {
  const closeTabBinding = useShortcutBinding('tabs.closeTab')
  const reopenTabBinding = useShortcutBinding('tabs.reopenTab')
  const nextTabBinding = useShortcutBinding('tabs.nextTab')
  const prevTabBinding = useShortcutBinding('tabs.prevTab')
  const navBackBinding = useShortcutBinding('tabs.navBack')
  const navForwardBinding = useShortcutBinding('tabs.navForward')

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

      // Close tab (⌘W) — closes the window only once Home is all that is left
      {
        key: closeTabBinding.key,
        modifiers: closeTabBinding.modifiers,
        action: () => {
          if (!activeTab) return

          if (isLastHomeTab(state, state.activeGroupId)) {
            window.api.windowClose()
          } else {
            closeTab(activeTab.id, state.activeGroupId)
          }
        },
        description: 'Close tab',
        // ⌘W must still close the tab while the caret sits in the note editor,
        // the capture bar, or any other field — same as a browser.
        allowInInput: true
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
        key: reopenTabBinding.key,
        modifiers: reopenTabBinding.modifiers,
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
        key: nextTabBinding.key,
        modifiers: nextTabBinding.modifiers,
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
        key: prevTabBinding.key,
        modifiers: prevTabBinding.modifiers,
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
        key: navBackBinding.key,
        modifiers: navBackBinding.modifiers,
        action: () => navBack(state.activeGroupId),
        description: 'Navigate back'
      },

      // Navigate forward in tab history (⌘])
      {
        key: navForwardBinding.key,
        modifiers: navForwardBinding.modifiers,
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
    closeTabBinding,
    reopenTabBinding,
    nextTabBinding,
    prevTabBinding,
    navBackBinding,
    navForwardBinding,
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
