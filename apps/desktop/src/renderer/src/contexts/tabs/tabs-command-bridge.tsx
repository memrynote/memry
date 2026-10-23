/**
 * Tabs command owner. Publishes which tab is active and supplies the behavior of
 * every `tabs.*` command, so a key, a menu item or a button all reach the same
 * code. Render once, inside `TabProvider`.
 */

import { useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'
import { publishActiveContext, useAppCommands } from '@/commands'
import { useTabs } from './context'
import { isLastHomeTab } from './helpers'
import { openNewTabMenu } from './new-tab-menu-opener'
import { duplicateTab, toggleTabPin } from './tab-ops'

export function TabsCommandBridge(): null {
  const { t } = useT('common')
  const { state, dispatch, closeTab, reopenClosedTab, splitView, navBack, navForward } = useTabs()

  const groupId = state.activeGroupId
  const group = state.tabGroups[groupId]
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId) ?? null
  const hasSplit = Object.keys(state.tabGroups).length > 1

  useEffect(() => {
    publishActiveContext({
      activeTabId: tab?.id ?? null,
      activeGroupId: groupId,
      activeTabType: tab?.type ?? null
    })
  }, [tab?.id, tab?.type, groupId])

  useAppCommands('tabs', {
    'tabs.newTab': {
      run: () => {
        openNewTabMenu(groupId)
      }
    },
    // Closes the window only once Home is all that is left.
    'tabs.closeTab': {
      enabled: tab !== null,
      run: () => {
        if (!tab) return
        if (isLastHomeTab(state, groupId)) window.api.windowClose()
        else closeTab(tab.id, groupId)
      }
    },
    'tabs.closeAllTabs': {
      run: () => {
        dispatch({ type: 'CLOSE_ALL_TABS', payload: { groupId } })
      }
    },
    'tabs.reopenTab': {
      run: () => {
        reopenClosedTab()
      }
    },
    'tabs.nextTab': {
      run: () => {
        dispatch({ type: 'GO_TO_NEXT_TAB', payload: { groupId } })
      }
    },
    'tabs.prevTab': {
      run: () => {
        dispatch({ type: 'GO_TO_PREVIOUS_TAB', payload: { groupId } })
      }
    },
    'tabs.navBack': {
      run: () => {
        navBack(groupId)
      }
    },
    'tabs.navForward': {
      run: () => {
        navForward(groupId)
      }
    },
    'tabs.pinTab': {
      enabled: tab !== null,
      label: tab?.isPinned ? t('tabs.unpin') : t('tabs.pin'),
      run: () => {
        if (tab) toggleTabPin(dispatch, tab, groupId)
      }
    },
    'tabs.duplicateTab': {
      enabled: tab !== null,
      run: () => {
        if (tab) duplicateTab(dispatch, tab, groupId)
      }
    },
    'tabs.splitRight': { run: () => void splitView('horizontal', groupId) },
    'tabs.splitDown': { run: () => void splitView('vertical', groupId) },
    'tabs.closeSplit': {
      enabled: hasSplit,
      run: () => {
        dispatch({ type: 'CLOSE_SPLIT', payload: { groupId } })
      }
    }
  })

  return null
}
