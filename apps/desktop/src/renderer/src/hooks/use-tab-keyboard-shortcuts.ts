/**
 * Tab Keyboard Shortcuts Hook
 * All keyboard shortcuts for tab management
 */

import { useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { isLastHomeTab } from '@/contexts/tabs/helpers'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import {
  chordAllowedInInput,
  useKeyboardShortcuts,
  type KeyboardShortcut
} from './use-keyboard-shortcuts-base'

/**
 * Hook providing all tab-related keyboard shortcuts
 *
 * Every chord is read from the binding store, so a rebind in Settings →
 * Shortcuts applies here immediately. Each one also fires with the caret in
 * the note editor or a text field, like a browser's tab keys, as long as it is
 * held with ⌘/Ctrl (see `chordAllowedInInput`).
 */
export const useTabKeyboardShortcuts = (): void => {
  const closeTabBinding = useShortcutBinding('tabs.closeTab')
  const reopenTabBinding = useShortcutBinding('tabs.reopenTab')
  const nextTabBinding = useShortcutBinding('tabs.nextTab')
  const prevTabBinding = useShortcutBinding('tabs.prevTab')
  const navBackBinding = useShortcutBinding('tabs.navBack')
  const navForwardBinding = useShortcutBinding('tabs.navForward')
  const newTabBinding = useShortcutBinding('tabs.newTab')
  const closeAllTabsBinding = useShortcutBinding('tabs.closeAllTabs')
  const pinTabBinding = useShortcutBinding('tabs.pinTab')
  const duplicateTabBinding = useShortcutBinding('tabs.duplicateTab')
  const splitRightBinding = useShortcutBinding('tabs.splitRight')
  const splitDownBinding = useShortcutBinding('tabs.splitDown')
  const closeSplitBinding = useShortcutBinding('tabs.closeSplit')

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
        key: newTabBinding.key,
        modifiers: newTabBinding.modifiers,
        action: () => {
          window.dispatchEvent(new CustomEvent('memry:new-tab-menu'))
        },
        description: 'New tab',
        allowInInput: chordAllowedInInput(newTabBinding)
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
        allowInInput: chordAllowedInInput(closeTabBinding)
      },

      // Close all tabs (⌘⇧W)
      {
        key: closeAllTabsBinding.key,
        modifiers: closeAllTabsBinding.modifiers,
        action: () => {
          dispatch({
            type: 'CLOSE_ALL_TABS',
            payload: { groupId: state.activeGroupId }
          })
        },
        description: 'Close all tabs',
        allowInInput: chordAllowedInInput(closeAllTabsBinding)
      },

      // Reopen closed tab (⌘⇧T) — like Chrome
      {
        key: reopenTabBinding.key,
        modifiers: reopenTabBinding.modifiers,
        action: () => {
          reopenClosedTab()
        },
        description: 'Reopen closed tab',
        allowInInput: chordAllowedInInput(reopenTabBinding)
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
        description: 'Next tab',
        allowInInput: chordAllowedInInput(nextTabBinding)
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
        description: 'Previous tab',
        allowInInput: chordAllowedInInput(prevTabBinding)
      },

      // Navigate back in tab history (⌘[)
      {
        key: navBackBinding.key,
        modifiers: navBackBinding.modifiers,
        action: () => navBack(state.activeGroupId),
        description: 'Navigate back',
        allowInInput: chordAllowedInInput(navBackBinding)
      },

      // Navigate forward in tab history (⌘])
      {
        key: navForwardBinding.key,
        modifiers: navForwardBinding.modifiers,
        action: () => navForward(state.activeGroupId),
        description: 'Navigate forward',
        allowInInput: chordAllowedInInput(navForwardBinding)
      },

      // NOTE: ⌘1-9 are intentionally NOT bound here. They now open the Nth
      // sidebar section (see app-sidebar.tsx / useModifierHeld). Ctrl+Tab and
      // Ctrl+Shift+Tab remain the way to cycle open tabs.

      // =====================================================================
      // TAB MODIFICATION
      // =====================================================================

      // Pin/Unpin tab (⌘⇧P)
      {
        key: pinTabBinding.key,
        modifiers: pinTabBinding.modifiers,
        action: () => {
          if (activeTab) {
            if (activeTab.isPinned) {
              unpinTab(activeTab.id, state.activeGroupId)
            } else {
              pinTab(activeTab.id, state.activeGroupId)
            }
          }
        },
        description: 'Pin/Unpin tab',
        allowInInput: chordAllowedInInput(pinTabBinding)
      },

      // Duplicate tab (⌘⇧D)
      {
        key: duplicateTabBinding.key,
        modifiers: duplicateTabBinding.modifiers,
        action: () => {
          if (activeTab) {
            // forceNew: without it the entity dedup just re-activates this tab.
            openTab(
              {
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
              },
              { forceNew: true }
            )
          }
        },
        description: 'Duplicate tab',
        allowInInput: chordAllowedInInput(duplicateTabBinding)
      },

      // =====================================================================
      // SPLIT VIEW
      // =====================================================================

      // Split right (⌘\)
      {
        key: splitRightBinding.key,
        modifiers: splitRightBinding.modifiers,
        action: () => {
          splitView('horizontal', state.activeGroupId)
        },
        description: 'Split right',
        allowInInput: chordAllowedInInput(splitRightBinding)
      },

      // Split down (⌘⇧\)
      {
        key: splitDownBinding.key,
        modifiers: splitDownBinding.modifiers,
        action: () => {
          splitView('vertical', state.activeGroupId)
        },
        description: 'Split down',
        allowInInput: chordAllowedInInput(splitDownBinding)
      },

      // Close split (⌘⌥W)
      {
        key: closeSplitBinding.key,
        modifiers: closeSplitBinding.modifiers,
        action: () => {
          if (Object.keys(state.tabGroups).length > 1) {
            dispatch({
              type: 'CLOSE_SPLIT',
              payload: { groupId: state.activeGroupId }
            })
          }
        },
        description: 'Close split pane',
        allowInInput: chordAllowedInInput(closeSplitBinding),
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
    newTabBinding,
    closeAllTabsBinding,
    pinTabBinding,
    duplicateTabBinding,
    splitRightBinding,
    splitDownBinding,
    closeSplitBinding,
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
  ])

  useKeyboardShortcuts(shortcuts)
}

export default useTabKeyboardShortcuts
