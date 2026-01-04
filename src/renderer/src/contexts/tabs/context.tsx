/**
 * Tab System Context and Provider
 * React context for tab state management
 */

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode
} from 'react'

import type {
  Tab,
  TabGroup,
  TabSystemState,
  TabAction,
  TabSettings,
  OpenTabOptions,
  SidebarItem
} from './types'
import { tabReducer } from './reducer'
import { createInitialState, createTabFromSidebarItem } from './helpers'

// =============================================================================
// CONTEXT TYPE
// =============================================================================

/**
 * Tab context interface providing state and methods
 */
interface TabContextType {
  /** Current tab system state */
  state: TabSystemState
  /** Dispatch function for actions */
  dispatch: React.Dispatch<TabAction>

  // =========================================================================
  // CONVENIENCE METHODS
  // =========================================================================

  /**
   * Open a new tab or focus existing if singleton/same entity
   */
  openTab: (tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>, options?: OpenTabOptions) => void

  /**
   * Open a tab from sidebar item
   */
  openFromSidebar: (
    item: SidebarItem,
    options?: Omit<OpenTabOptions, 'forceNew'> & { isPreview?: boolean }
  ) => void

  /**
   * Close a tab
   */
  closeTab: (tabId: string, groupId?: string) => void

  /**
   * Close other tabs in the same group
   */
  closeOtherTabs: (tabId: string, groupId?: string) => void

  /**
   * Close tabs to the right
   */
  closeTabsToRight: (tabId: string, groupId?: string) => void

  /**
   * Close all tabs in a group
   */
  closeAllTabs: (groupId?: string) => void

  /**
   * Set the active tab
   */
  setActiveTab: (tabId: string, groupId?: string) => void

  /**
   * Set the active group (for split views)
   */
  setActiveGroup: (groupId: string) => void

  /**
   * Navigate to next tab
   */
  goToNextTab: (groupId?: string) => void

  /**
   * Navigate to previous tab
   */
  goToPreviousTab: (groupId?: string) => void

  /**
   * Navigate to tab by index (1-9 for Ctrl+1-9)
   */
  goToTabIndex: (index: number, groupId?: string) => void

  /**
   * Pin a tab
   */
  pinTab: (tabId: string, groupId?: string) => void

  /**
   * Unpin a tab
   */
  unpinTab: (tabId: string, groupId?: string) => void

  /**
   * Toggle pin state
   */
  togglePinTab: (tabId: string, groupId?: string) => void

  /**
   * Mark a tab as modified (unsaved changes)
   */
  setTabModified: (tabId: string, isModified: boolean, groupId?: string) => void

  /**
   * Mark a tab as deleted (strikethrough styling) by entity ID
   */
  setTabDeleted: (entityId: string, isDeleted: boolean) => void

  /**
   * Update a tab's title
   */
  updateTabTitle: (tabId: string, title: string, groupId?: string) => void

  /**
   * Promote a preview tab to permanent
   */
  promotePreviewTab: (tabId: string, groupId?: string) => void

  /**
   * Reorder tabs within a group
   */
  reorderTabs: (fromIndex: number, toIndex: number, groupId?: string) => void

  /**
   * Move a tab to another group
   */
  moveTabToGroup: (tabId: string, fromGroupId: string, toGroupId: string, toIndex: number) => void

  /**
   * Save tab state (scroll position, view state)
   */
  saveTabState: (
    tabId: string,
    state: { scrollPosition?: number; viewState?: Record<string, unknown> },
    groupId?: string
  ) => void

  /**
   * Split the view
   */
  splitView: (direction: 'horizontal', groupId?: string) => void

  /**
   * Close a split pane
   */
  closeSplit: (groupId: string) => void

  /**
   * Move a tab to a new split
   */
  moveTabToNewSplit: (tabId: string, fromGroupId: string, direction: 'left' | 'right') => void

  /**
   * Update tab settings
   */
  updateSettings: (settings: Partial<TabSettings>) => void

  /**
   * Restore session from saved state
   */
  restoreSession: (state: TabSystemState) => void

  /**
   * Reset to default state
   */
  resetToDefault: () => void

  // =========================================================================
  // SELECTORS
  // =========================================================================

  /**
   * Get the currently active tab
   */
  getActiveTab: () => Tab | null

  /**
   * Get the currently active tab group
   */
  getActiveGroup: () => TabGroup | null

  /**
   * Get all tabs across all groups
   */
  getAllTabs: () => Tab[]

  /**
   * Get tabs in a specific group
   */
  getTabsInGroup: (groupId: string) => Tab[]

  /**
   * Check if a tab exists by entity ID
   */
  hasTabForEntity: (entityId: string) => boolean
}

// =============================================================================
// CONTEXT CREATION
// =============================================================================

const TabContext = createContext<TabContextType | null>(null)

// =============================================================================
// PROVIDER COMPONENT
// =============================================================================

interface TabProviderProps {
  children: ReactNode
  /** Optional initial state (for session restore) */
  initialState?: TabSystemState
  /** Optional initial settings from database (overrides defaults) */
  initialSettings?: Partial<TabSettings>
}

export const TabProvider = ({
  children,
  initialState,
  initialSettings
}: TabProviderProps): React.JSX.Element => {
  // Create initial state with database settings if provided
  const computedInitialState = useMemo(() => {
    const baseState = initialState ?? createInitialState()
    if (initialSettings) {
      return {
        ...baseState,
        settings: {
          ...baseState.settings,
          ...initialSettings
        }
      }
    }
    return baseState
  }, [initialState, initialSettings])

  const [state, dispatch] = useReducer(tabReducer, computedInitialState)

  // Use refs for state values to avoid callback dependency changes
  // This prevents cascade re-renders when activeGroupId/tabGroups change
  const activeGroupIdRef = useRef(state.activeGroupId)
  const tabGroupsRef = useRef(state.tabGroups)

  // Keep refs in sync with state (must be in useEffect per React rules)
  useEffect(() => {
    activeGroupIdRef.current = state.activeGroupId
    tabGroupsRef.current = state.tabGroups
  })

  // Listen for settings changes from the database (other windows, settings page)
  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'tabs') {
        // Update settings from database change
        dispatch({
          type: 'UPDATE_SETTINGS',
          payload: event.value as Partial<TabSettings>
        })
      }
    })

    return unsubscribe
  }, [])

  // =========================================================================
  // CONVENIENCE METHODS
  // =========================================================================

  const openTab = useCallback(
    (
      tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>,
      options: OpenTabOptions & { replaceActive?: boolean } = {}
    ) => {
      dispatch({
        type: 'OPEN_TAB',
        payload: {
          tab,
          groupId: options.groupId,
          position: options.position,
          background: options.background,
          replaceActive: options.replaceActive
        }
      })
    },
    []
  )

  const openFromSidebar = useCallback(
    (
      item: SidebarItem,
      options: Omit<OpenTabOptions, 'forceNew'> & { isPreview?: boolean } = {}
    ) => {
      const tab = createTabFromSidebarItem(item, options.isPreview ?? false)
      dispatch({
        type: 'OPEN_TAB',
        payload: {
          tab,
          groupId: options.groupId,
          position: options.position,
          background: options.background
        }
      })
    },
    []
  )

  const closeTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'CLOSE_TAB',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const closeOtherTabs = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'CLOSE_OTHER_TABS',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const closeTabsToRight = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'CLOSE_TABS_TO_RIGHT',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const closeAllTabs = useCallback((groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'CLOSE_ALL_TABS',
      payload: { groupId: actualGroupId }
    })
  }, [])

  const setActiveTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'SET_ACTIVE_TAB',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const setActiveGroup = useCallback((groupId: string) => {
    dispatch({
      type: 'SET_ACTIVE_GROUP',
      payload: { groupId }
    })
  }, [])

  const goToNextTab = useCallback((groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'GO_TO_NEXT_TAB',
      payload: { groupId: actualGroupId }
    })
  }, [])

  const goToPreviousTab = useCallback((groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'GO_TO_PREVIOUS_TAB',
      payload: { groupId: actualGroupId }
    })
  }, [])

  const goToTabIndex = useCallback((index: number, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'GO_TO_TAB_INDEX',
      payload: { index, groupId: actualGroupId }
    })
  }, [])

  const pinTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'PIN_TAB',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const unpinTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'UNPIN_TAB',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const togglePinTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    const group = tabGroupsRef.current[actualGroupId]
    const tab = group?.tabs.find((t) => t.id === tabId)
    if (tab) {
      dispatch({
        type: tab.isPinned ? 'UNPIN_TAB' : 'PIN_TAB',
        payload: { tabId, groupId: actualGroupId }
      })
    }
  }, [])

  const setTabModified = useCallback((tabId: string, isModified: boolean, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'SET_TAB_MODIFIED',
      payload: { tabId, groupId: actualGroupId, isModified }
    })
  }, [])

  const setTabDeleted = useCallback((entityId: string, isDeleted: boolean) => {
    // Find the tab by entityId across all groups
    for (const [groupId, group] of Object.entries(tabGroupsRef.current)) {
      const tab = group.tabs.find((t) => t.entityId === entityId)
      if (tab) {
        dispatch({
          type: 'SET_TAB_DELETED',
          payload: { tabId: tab.id, groupId, isDeleted }
        })
        return
      }
    }
  }, [])

  const updateTabTitle = useCallback((tabId: string, title: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'UPDATE_TAB_TITLE',
      payload: { tabId, groupId: actualGroupId, title }
    })
  }, [])

  const promotePreviewTab = useCallback((tabId: string, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'PROMOTE_PREVIEW_TAB',
      payload: { tabId, groupId: actualGroupId }
    })
  }, [])

  const reorderTabs = useCallback((fromIndex: number, toIndex: number, groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'REORDER_TABS',
      payload: { groupId: actualGroupId, fromIndex, toIndex }
    })
  }, [])

  const moveTabToGroup = useCallback(
    (tabId: string, fromGroupId: string, toGroupId: string, toIndex: number) => {
      dispatch({
        type: 'MOVE_TAB',
        payload: { tabId, fromGroupId, toGroupId, toIndex }
      })
    },
    []
  )

  const saveTabState = useCallback(
    (
      tabId: string,
      tabState: { scrollPosition?: number; viewState?: Record<string, unknown> },
      groupId?: string
    ) => {
      const actualGroupId = groupId ?? activeGroupIdRef.current
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: {
          tabId,
          groupId: actualGroupId,
          ...tabState
        }
      })
    },
    []
  )

  const splitView = useCallback((direction: 'horizontal', groupId?: string) => {
    const actualGroupId = groupId ?? activeGroupIdRef.current
    dispatch({
      type: 'SPLIT_VIEW',
      payload: { direction, groupId: actualGroupId }
    })
  }, [])

  const closeSplit = useCallback((groupId: string) => {
    dispatch({
      type: 'CLOSE_SPLIT',
      payload: { groupId }
    })
  }, [])

  const moveTabToNewSplit = useCallback(
    (tabId: string, fromGroupId: string, direction: 'left' | 'right') => {
      dispatch({
        type: 'MOVE_TAB_TO_NEW_SPLIT',
        payload: { tabId, fromGroupId, direction }
      })
    },
    []
  )

  const updateSettings = useCallback((settings: Partial<TabSettings>) => {
    dispatch({
      type: 'UPDATE_SETTINGS',
      payload: settings
    })
  }, [])

  const restoreSession = useCallback((sessionState: TabSystemState) => {
    dispatch({
      type: 'RESTORE_SESSION',
      payload: sessionState
    })
  }, [])

  const resetToDefault = useCallback(() => {
    dispatch({ type: 'RESET_TO_DEFAULT' })
  }, [])

  // =========================================================================
  // SELECTORS
  // =========================================================================

  const getActiveTab = useCallback((): Tab | null => {
    const group = state.tabGroups[state.activeGroupId]
    if (!group || !group.activeTabId) return null
    return group.tabs.find((t) => t.id === group.activeTabId) ?? null
  }, [state.tabGroups, state.activeGroupId])

  const getActiveGroup = useCallback((): TabGroup | null => {
    return state.tabGroups[state.activeGroupId] ?? null
  }, [state.tabGroups, state.activeGroupId])

  const getAllTabs = useCallback((): Tab[] => {
    return Object.values(state.tabGroups).flatMap((g) => g.tabs)
  }, [state.tabGroups])

  const getTabsInGroup = useCallback(
    (groupId: string): Tab[] => {
      return state.tabGroups[groupId]?.tabs ?? []
    },
    [state.tabGroups]
  )

  const hasTabForEntity = useCallback(
    (entityId: string): boolean => {
      return Object.values(state.tabGroups).some((g) => g.tabs.some((t) => t.entityId === entityId))
    },
    [state.tabGroups]
  )

  // =========================================================================
  // CONTEXT VALUE
  // =========================================================================

  const value = useMemo<TabContextType>(
    () => ({
      state,
      dispatch,
      // Methods
      openTab,
      openFromSidebar,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      setActiveTab,
      setActiveGroup,
      goToNextTab,
      goToPreviousTab,
      goToTabIndex,
      pinTab,
      unpinTab,
      togglePinTab,
      setTabModified,
      setTabDeleted,
      updateTabTitle,
      promotePreviewTab,
      reorderTabs,
      moveTabToGroup,
      saveTabState,
      splitView,
      closeSplit,
      moveTabToNewSplit,
      updateSettings,
      restoreSession,
      resetToDefault,
      // Selectors
      getActiveTab,
      getActiveGroup,
      getAllTabs,
      getTabsInGroup,
      hasTabForEntity
    }),
    [
      state,
      openTab,
      openFromSidebar,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      setActiveTab,
      setActiveGroup,
      goToNextTab,
      goToPreviousTab,
      goToTabIndex,
      pinTab,
      unpinTab,
      togglePinTab,
      setTabModified,
      setTabDeleted,
      updateTabTitle,
      promotePreviewTab,
      reorderTabs,
      moveTabToGroup,
      saveTabState,
      splitView,
      closeSplit,
      moveTabToNewSplit,
      updateSettings,
      restoreSession,
      resetToDefault,
      getActiveTab,
      getActiveGroup,
      getAllTabs,
      getTabsInGroup,
      hasTabForEntity
    ]
  )

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Main hook to access tab context
 * Must be used within a TabProvider
 */
export const useTabs = (): TabContextType => {
  const context = useContext(TabContext)
  if (!context) {
    throw new Error('useTabs must be used within a TabProvider')
  }
  return context
}

/**
 * Hook to get a specific tab group
 */
export const useTabGroup = (groupId: string): TabGroup | null => {
  const { state } = useTabs()
  return state.tabGroups[groupId] ?? null
}

/**
 * Hook to get the active tab in a specific group or the active group
 */
export const useActiveTab = (groupId?: string): Tab | null => {
  const { state } = useTabs()
  const targetGroupId = groupId ?? state.activeGroupId
  const group = state.tabGroups[targetGroupId]

  if (!group || !group.activeTabId) return null
  return group.tabs.find((t) => t.id === group.activeTabId) ?? null
}

/**
 * Hook to get the active group
 */
export const useActiveGroup = (): TabGroup | null => {
  const { state } = useTabs()
  return state.tabGroups[state.activeGroupId] ?? null
}

/**
 * Hook to get all tabs in the active group
 */
export const useActiveGroupTabs = (): Tab[] => {
  const group = useActiveGroup()
  return group?.tabs ?? []
}

/**
 * Hook to get tab settings
 */
export const useTabSettings = (): TabSettings => {
  const { state } = useTabs()
  return state.settings
}

/**
 * Hook to check if a specific tab is active
 */
export const useIsTabActive = (tabId: string, groupId?: string): boolean => {
  const { state } = useTabs()
  const targetGroupId = groupId ?? state.activeGroupId
  const group = state.tabGroups[targetGroupId]

  return group?.activeTabId === tabId && state.activeGroupId === targetGroupId
}

/**
 * Hook to get the layout
 */
export const useTabLayout = () => {
  const { state } = useTabs()
  return state.layout
}

/**
 * Hook for tab counts (useful for badges, etc.)
 */
export const useTabCounts = () => {
  const { state } = useTabs()

  return useMemo(() => {
    const allTabs = Object.values(state.tabGroups).flatMap((g) => g.tabs)
    return {
      total: allTabs.length,
      pinned: allTabs.filter((t) => t.isPinned).length,
      modified: allTabs.filter((t) => t.isModified).length,
      preview: allTabs.filter((t) => t.isPreview).length,
      groups: Object.keys(state.tabGroups).length
    }
  }, [state.tabGroups])
}

/**
 * Hook to get only tab actions (stable references that don't change)
 * Use this when you only need to perform actions like openTab, closeTab, etc.
 * This prevents re-renders when tab state changes.
 */
export const useTabActions = () => {
  const {
    openTab,
    openFromSidebar,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    setActiveTab,
    setActiveGroup,
    goToNextTab,
    goToPreviousTab,
    goToTabIndex,
    pinTab,
    unpinTab,
    togglePinTab,
    setTabModified,
    setTabDeleted,
    updateTabTitle,
    promotePreviewTab,
    reorderTabs,
    moveTabToGroup,
    saveTabState,
    splitView,
    closeSplit,
    moveTabToNewSplit,
    updateSettings,
    restoreSession,
    resetToDefault,
    dispatch
  } = useTabs()

  // Return only actions - these are stable references due to useCallback with empty deps
  return useMemo(
    () => ({
      openTab,
      openFromSidebar,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      setActiveTab,
      setActiveGroup,
      goToNextTab,
      goToPreviousTab,
      goToTabIndex,
      pinTab,
      unpinTab,
      togglePinTab,
      setTabModified,
      setTabDeleted,
      updateTabTitle,
      promotePreviewTab,
      reorderTabs,
      moveTabToGroup,
      saveTabState,
      splitView,
      closeSplit,
      moveTabToNewSplit,
      updateSettings,
      restoreSession,
      resetToDefault,
      dispatch
    }),
    [
      openTab,
      openFromSidebar,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      setActiveTab,
      setActiveGroup,
      goToNextTab,
      goToPreviousTab,
      goToTabIndex,
      pinTab,
      unpinTab,
      togglePinTab,
      setTabModified,
      setTabDeleted,
      updateTabTitle,
      promotePreviewTab,
      reorderTabs,
      moveTabToGroup,
      saveTabState,
      splitView,
      closeSplit,
      moveTabToNewSplit,
      updateSettings,
      restoreSession,
      resetToDefault,
      dispatch
    ]
  )
}
