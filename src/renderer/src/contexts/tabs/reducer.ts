/**
 * Tab System Reducer
 * Handles all tab state mutations with immutable updates
 */

import type {
  Tab,
  TabAction,
  TabGroup,
  TabSystemState,
  ClosedTab,
} from './types';
import { SINGLETON_TAB_TYPES } from './types';
import {
  generateId,
  findExistingTab,
  findTabByEntityId,
  createDefaultTab,
  createEmptyTabGroup,
  insertSplitAtGroup,
  removeGroupFromLayout,
  createInitialState,
  getInsertIndexAfterPinned,
} from './helpers';

// =============================================================================
// HELPER: CLOSE GROUP
// =============================================================================

/**
 * Close a group and update layout/state accordingly
 */
const closeGroup = (
  state: TabSystemState,
  groupId: string,
  recentlyClosed: ClosedTab[]
): TabSystemState => {
  // Remove group from state
  const { [groupId]: removedGroup, ...remainingGroups } = state.tabGroups;

  // Update layout
  const newLayout = removeGroupFromLayout(state.layout, groupId);

  // If layout is null (was the only group), reset to default
  if (!newLayout) {
    return {
      ...createInitialState(),
      recentlyClosed,
      settings: state.settings,
    };
  }

  // Determine new active group
  let newActiveGroupId = state.activeGroupId;
  if (state.activeGroupId === groupId) {
    // Find first available group
    const availableGroupIds = Object.keys(remainingGroups);
    newActiveGroupId = availableGroupIds[0] || state.activeGroupId;
  }

  return {
    ...state,
    tabGroups: remainingGroups,
    layout: newLayout,
    activeGroupId: newActiveGroupId,
    recentlyClosed,
  };
};

// =============================================================================
// TAB REDUCER
// =============================================================================

export function tabReducer(
  state: TabSystemState,
  action: TabAction
): TabSystemState {
  switch (action.type) {
    // =========================================================================
    // TAB CRUD ACTIONS
    // =========================================================================

    case 'OPEN_TAB': {
      const { tab, groupId = state.activeGroupId, position, background } = action.payload;
      const targetGroup = state.tabGroups[groupId];

      if (!targetGroup) return state;

      // Check for singleton - if already open, focus existing
      if (SINGLETON_TAB_TYPES.includes(tab.type)) {
        const existingTab = findExistingTab(state, tab.type);
        if (existingTab) {
          // Just focus the existing tab
          return {
            ...state,
            tabGroups: {
              ...state.tabGroups,
              [existingTab.groupId]: {
                ...state.tabGroups[existingTab.groupId],
                activeTabId: background
                  ? state.tabGroups[existingTab.groupId].activeTabId
                  : existingTab.tab.id,
                tabs: state.tabGroups[existingTab.groupId].tabs.map((t) =>
                  t.id === existingTab.tab.id
                    ? { ...t, lastAccessedAt: Date.now() }
                    : t
                ),
              },
            },
            activeGroupId: background ? state.activeGroupId : existingTab.groupId,
          };
        }
      }

      // Check for existing tab with same entityId (e.g., same note)
      if (tab.entityId) {
        const existingTab = findTabByEntityId(state, tab.entityId);
        if (existingTab) {
          return {
            ...state,
            tabGroups: {
              ...state.tabGroups,
              [existingTab.groupId]: {
                ...state.tabGroups[existingTab.groupId],
                activeTabId: background
                  ? state.tabGroups[existingTab.groupId].activeTabId
                  : existingTab.tab.id,
                tabs: state.tabGroups[existingTab.groupId].tabs.map((t) =>
                  t.id === existingTab.tab.id
                    ? { ...t, lastAccessedAt: Date.now() }
                    : t
                ),
              },
            },
            activeGroupId: background ? state.activeGroupId : existingTab.groupId,
          };
        }
      }

      // Handle preview mode - replace existing preview tab
      if (state.settings.previewMode && tab.isPreview) {
        const previewTabIndex = targetGroup.tabs.findIndex((t) => t.isPreview);
        if (previewTabIndex !== -1) {
          const newTab: Tab = {
            ...tab,
            id: generateId(),
            openedAt: Date.now(),
            lastAccessedAt: Date.now(),
          };
          const newTabs = [...targetGroup.tabs];
          newTabs[previewTabIndex] = newTab;

          return {
            ...state,
            tabGroups: {
              ...state.tabGroups,
              [groupId]: {
                ...targetGroup,
                tabs: newTabs,
                activeTabId: background ? targetGroup.activeTabId : newTab.id,
              },
            },
            activeGroupId: background ? state.activeGroupId : groupId,
          };
        }
      }

      // Create new tab
      const newTab: Tab = {
        ...tab,
        id: generateId(),
        openedAt: Date.now(),
        lastAccessedAt: Date.now(),
      };

      // Determine position
      let insertIndex = position ?? targetGroup.tabs.length;

      // If showing pinned tabs first and new tab is not pinned,
      // insert after pinned tabs
      if (state.settings.showPinnedTabsFirst && !tab.isPinned) {
        const afterPinnedIndex = getInsertIndexAfterPinned(targetGroup.tabs);
        insertIndex = Math.max(insertIndex, afterPinnedIndex);
      }

      // Ensure index is within bounds
      insertIndex = Math.min(insertIndex, targetGroup.tabs.length);

      const newTabs = [
        ...targetGroup.tabs.slice(0, insertIndex),
        newTab,
        ...targetGroup.tabs.slice(insertIndex),
      ];

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...targetGroup,
            tabs: newTabs,
            activeTabId: background ? targetGroup.activeTabId : newTab.id,
          },
        },
        activeGroupId: background ? state.activeGroupId : groupId,
      };
    }

    case 'CLOSE_TAB': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const closingTab = group.tabs[tabIndex];

      // Add to recently closed (but not preview tabs)
      let newRecentlyClosed = state.recentlyClosed;
      if (!closingTab.isPreview) {
        const closedTab: ClosedTab = {
          tab: closingTab,
          groupId,
          index: tabIndex,
          closedAt: Date.now(),
        };
        newRecentlyClosed = [closedTab, ...state.recentlyClosed].slice(
          0,
          state.settings.maxRecentlyClosed
        );
      }

      // Remove tab
      const newTabs = group.tabs.filter((t) => t.id !== tabId);

      // Handle last tab in group
      if (newTabs.length === 0) {
        // If this is the only group, add a default tab
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab();
          return {
            ...state,
            tabGroups: {
              [groupId]: {
                ...group,
                tabs: [defaultTab],
                activeTabId: defaultTab.id,
              },
            },
            recentlyClosed: newRecentlyClosed,
          };
        }

        // Otherwise, close the group
        return closeGroup(state, groupId, newRecentlyClosed);
      }

      // Determine new active tab
      let newActiveTabId = group.activeTabId;
      if (group.activeTabId === tabId) {
        // Activate tab to the right, or the last tab
        const newActiveIndex = Math.min(tabIndex, newTabs.length - 1);
        newActiveTabId = newTabs[newActiveIndex].id;
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: newTabs,
            activeTabId: newActiveTabId,
          },
        },
        recentlyClosed: newRecentlyClosed,
      };
    }

    case 'CLOSE_OTHER_TABS': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tabToKeep = group.tabs.find((t) => t.id === tabId);
      if (!tabToKeep) return state;

      // Keep pinned tabs and the selected tab
      const tabsToKeep = group.tabs.filter((t) => t.id === tabId || t.isPinned);
      const tabsToClose = group.tabs.filter((t) => t.id !== tabId && !t.isPinned);

      // Add closed tabs to recently closed
      const closedTabs: ClosedTab[] = tabsToClose
        .filter((t) => !t.isPreview)
        .map((t, i) => ({
          tab: t,
          groupId,
          index: group.tabs.findIndex((gt) => gt.id === t.id),
          closedAt: Date.now() + i,
        }));

      const newRecentlyClosed = [...closedTabs, ...state.recentlyClosed].slice(
        0,
        state.settings.maxRecentlyClosed
      );

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: tabsToKeep,
            activeTabId: tabId,
          },
        },
        recentlyClosed: newRecentlyClosed,
      };
    }

    case 'CLOSE_TABS_TO_RIGHT': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      // Keep tabs before and including the selected tab, plus any pinned tabs after
      const tabsToKeep = group.tabs.filter(
        (t, i) => i <= tabIndex || t.isPinned
      );
      const tabsToClose = group.tabs.filter(
        (t, i) => i > tabIndex && !t.isPinned
      );

      // Add closed tabs to recently closed
      const closedTabs: ClosedTab[] = tabsToClose
        .filter((t) => !t.isPreview)
        .map((t) => ({
          tab: t,
          groupId,
          index: group.tabs.findIndex((gt) => gt.id === t.id),
          closedAt: Date.now(),
        }));

      const newRecentlyClosed = [...closedTabs, ...state.recentlyClosed].slice(
        0,
        state.settings.maxRecentlyClosed
      );

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: tabsToKeep,
          },
        },
        recentlyClosed: newRecentlyClosed,
      };
    }

    case 'CLOSE_ALL_TABS': {
      const { groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      // Keep only pinned tabs
      const pinnedTabs = group.tabs.filter((t) => t.isPinned);
      const tabsToClose = group.tabs.filter((t) => !t.isPinned);

      // Add to recently closed
      const closedTabs: ClosedTab[] = tabsToClose
        .filter((t) => !t.isPreview)
        .map((t) => ({
          tab: t,
          groupId,
          index: group.tabs.findIndex((gt) => gt.id === t.id),
          closedAt: Date.now(),
        }));

      const newRecentlyClosed = [...closedTabs, ...state.recentlyClosed].slice(
        0,
        state.settings.maxRecentlyClosed
      );

      // If no pinned tabs, add default or close group
      if (pinnedTabs.length === 0) {
        if (Object.keys(state.tabGroups).length === 1) {
          const defaultTab = createDefaultTab();
          return {
            ...state,
            tabGroups: {
              [groupId]: {
                ...group,
                tabs: [defaultTab],
                activeTabId: defaultTab.id,
              },
            },
            recentlyClosed: newRecentlyClosed,
          };
        }
        return closeGroup(state, groupId, newRecentlyClosed);
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: pinnedTabs,
            activeTabId: pinnedTabs[0]?.id || null,
          },
        },
        recentlyClosed: newRecentlyClosed,
      };
    }

    case 'CLOSE_GROUP': {
      const { groupId } = action.payload;

      // Can't close the last group
      if (Object.keys(state.tabGroups).length === 1) {
        return state;
      }

      const group = state.tabGroups[groupId];
      if (!group) return state;

      // Add all non-preview tabs to recently closed
      const closedTabs: ClosedTab[] = group.tabs
        .filter((t) => !t.isPreview)
        .map((t, i) => ({
          tab: t,
          groupId,
          index: i,
          closedAt: Date.now(),
        }));

      const newRecentlyClosed = [...closedTabs, ...state.recentlyClosed].slice(
        0,
        state.settings.maxRecentlyClosed
      );

      return closeGroup(state, groupId, newRecentlyClosed);
    }

    // =========================================================================
    // TAB NAVIGATION ACTIONS
    // =========================================================================

    case 'SET_ACTIVE_TAB': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tab = group.tabs.find((t) => t.id === tabId);
      if (!tab) return state;

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: tabId,
            tabs: group.tabs.map((t) =>
              t.id === tabId ? { ...t, lastAccessedAt: Date.now() } : t
            ),
          },
        },
        activeGroupId: groupId,
      };
    }

    case 'SET_ACTIVE_GROUP': {
      const { groupId } = action.payload;

      if (!state.tabGroups[groupId]) return state;

      // Update isActive flags
      const updatedGroups = Object.fromEntries(
        Object.entries(state.tabGroups).map(([id, group]) => [
          id,
          { ...group, isActive: id === groupId },
        ])
      );

      return {
        ...state,
        tabGroups: updatedGroups,
        activeGroupId: groupId,
      };
    }

    case 'GO_TO_NEXT_TAB': {
      const { groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group || group.tabs.length === 0) return state;

      const currentIndex = group.tabs.findIndex(
        (t) => t.id === group.activeTabId
      );
      const nextIndex = (currentIndex + 1) % group.tabs.length;
      const nextTab = group.tabs[nextIndex];

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: nextTab.id,
            tabs: group.tabs.map((t) =>
              t.id === nextTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            ),
          },
        },
      };
    }

    case 'GO_TO_PREVIOUS_TAB': {
      const { groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group || group.tabs.length === 0) return state;

      const currentIndex = group.tabs.findIndex(
        (t) => t.id === group.activeTabId
      );
      const prevIndex =
        currentIndex === 0 ? group.tabs.length - 1 : currentIndex - 1;
      const prevTab = group.tabs[prevIndex];

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: prevTab.id,
            tabs: group.tabs.map((t) =>
              t.id === prevTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            ),
          },
        },
      };
    }

    case 'GO_TO_TAB_INDEX': {
      const { index, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group || index < 0 || index >= group.tabs.length) return state;

      const targetTab = group.tabs[index];

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            activeTabId: targetTab.id,
            tabs: group.tabs.map((t) =>
              t.id === targetTab.id ? { ...t, lastAccessedAt: Date.now() } : t
            ),
          },
        },
      };
    }

    // =========================================================================
    // TAB MODIFICATION ACTIONS
    // =========================================================================

    case 'PIN_TAB': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const tab = { ...group.tabs[tabIndex], isPinned: true, isPreview: false };
      let newTabs = group.tabs.filter((t) => t.id !== tabId);

      // Move to end of pinned tabs
      if (state.settings.showPinnedTabsFirst) {
        const lastPinnedIndex = newTabs.findLastIndex((t) => t.isPinned);
        newTabs = [
          ...newTabs.slice(0, lastPinnedIndex + 1),
          tab,
          ...newTabs.slice(lastPinnedIndex + 1),
        ];
      } else {
        newTabs = [...newTabs.slice(0, tabIndex), tab, ...newTabs.slice(tabIndex)];
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: newTabs,
          },
        },
      };
    }

    case 'UNPIN_TAB': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const tab = { ...group.tabs[tabIndex], isPinned: false };
      let newTabs = group.tabs.filter((t) => t.id !== tabId);

      if (state.settings.showPinnedTabsFirst) {
        // Move to start of unpinned tabs (after pinned)
        const lastPinnedIndex = newTabs.findLastIndex((t) => t.isPinned);
        newTabs = [
          ...newTabs.slice(0, lastPinnedIndex + 1),
          tab,
          ...newTabs.slice(lastPinnedIndex + 1),
        ];
      } else {
        newTabs = [...newTabs.slice(0, tabIndex), tab, ...newTabs.slice(tabIndex)];
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: newTabs,
          },
        },
      };
    }

    case 'SET_TAB_MODIFIED': {
      const { tabId, groupId, isModified } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.id === tabId ? { ...t, isModified } : t
            ),
          },
        },
      };
    }

    case 'UPDATE_TAB_TITLE': {
      const { tabId, groupId, title } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.id === tabId ? { ...t, title } : t
            ),
          },
        },
      };
    }

    case 'PROMOTE_PREVIEW_TAB': {
      const { tabId, groupId } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.id === tabId ? { ...t, isPreview: false } : t
            ),
          },
        },
      };
    }

    // =========================================================================
    // TAB REORDERING ACTIONS
    // =========================================================================

    case 'REORDER_TABS': {
      const { groupId, fromIndex, toIndex } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;
      if (fromIndex === toIndex) return state;
      if (fromIndex < 0 || fromIndex >= group.tabs.length) return state;
      if (toIndex < 0 || toIndex >= group.tabs.length) return state;

      const newTabs = [...group.tabs];
      const [movedTab] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, movedTab);

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: newTabs,
          },
        },
      };
    }

    case 'MOVE_TAB': {
      const { tabId, fromGroupId, toGroupId, toIndex } = action.payload;
      const fromGroup = state.tabGroups[fromGroupId];
      const toGroup = state.tabGroups[toGroupId];

      if (!fromGroup || !toGroup) return state;

      const tab = fromGroup.tabs.find((t) => t.id === tabId);
      if (!tab) return state;

      // Remove from source group
      const newFromTabs = fromGroup.tabs.filter((t) => t.id !== tabId);

      // Handle if source group becomes empty
      if (newFromTabs.length === 0 && Object.keys(state.tabGroups).length > 1) {
        // Close source group and add tab to target
        const newToTabs = [
          ...toGroup.tabs.slice(0, toIndex),
          { ...tab, lastAccessedAt: Date.now() },
          ...toGroup.tabs.slice(toIndex),
        ];

        const stateWithTab = {
          ...state,
          tabGroups: {
            ...state.tabGroups,
            [toGroupId]: {
              ...toGroup,
              tabs: newToTabs,
              activeTabId: tab.id,
            },
          },
          activeGroupId: toGroupId,
        };

        return closeGroup(stateWithTab, fromGroupId, state.recentlyClosed);
      }

      // Add to target group
      const newToTabs = [
        ...toGroup.tabs.slice(0, toIndex),
        { ...tab, lastAccessedAt: Date.now() },
        ...toGroup.tabs.slice(toIndex),
      ];

      // Update active tab in source group if needed
      let newFromActiveTabId = fromGroup.activeTabId;
      if (fromGroup.activeTabId === tabId && newFromTabs.length > 0) {
        const oldIndex = fromGroup.tabs.findIndex((t) => t.id === tabId);
        const newIndex = Math.min(oldIndex, newFromTabs.length - 1);
        newFromActiveTabId = newFromTabs[newIndex].id;
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [fromGroupId]: {
            ...fromGroup,
            tabs: newFromTabs,
            activeTabId: newFromActiveTabId,
          },
          [toGroupId]: {
            ...toGroup,
            tabs: newToTabs,
            activeTabId: tab.id,
          },
        },
        activeGroupId: toGroupId,
      };
    }

    // =========================================================================
    // TAB STATE PRESERVATION
    // =========================================================================

    case 'SAVE_TAB_STATE': {
      const { tabId, groupId, scrollPosition, viewState } = action.payload;
      const group = state.tabGroups[groupId];

      if (!group) return state;

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    ...(scrollPosition !== undefined && { scrollPosition }),
                    ...(viewState !== undefined && { viewState }),
                  }
                : t
            ),
          },
        },
      };
    }

    // =========================================================================
    // RECENTLY CLOSED ACTIONS
    // =========================================================================

    case 'REOPEN_CLOSED_TAB': {
      if (state.recentlyClosed.length === 0) return state;

      const [closedTab, ...remainingClosed] = state.recentlyClosed;
      const { tab, groupId, index } = closedTab;

      // Check if original group still exists, otherwise use active group
      const targetGroupId = state.tabGroups[groupId]
        ? groupId
        : state.activeGroupId;
      const targetGroup = state.tabGroups[targetGroupId];

      if (!targetGroup) return state;

      const newTab = {
        ...tab,
        id: generateId(), // New ID to avoid conflicts
        openedAt: Date.now(),
        lastAccessedAt: Date.now(),
        isPreview: false, // Don't reopen as preview
      };

      const insertIndex = Math.min(index, targetGroup.tabs.length);
      const newTabs = [
        ...targetGroup.tabs.slice(0, insertIndex),
        newTab,
        ...targetGroup.tabs.slice(insertIndex),
      ];

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [targetGroupId]: {
            ...targetGroup,
            tabs: newTabs,
            activeTabId: newTab.id,
          },
        },
        recentlyClosed: remainingClosed,
        activeGroupId: targetGroupId,
      };
    }

    case 'REOPEN_SPECIFIC_CLOSED_TAB': {
      const { index } = action.payload;

      if (index < 0 || index >= state.recentlyClosed.length) return state;

      const closedTab = state.recentlyClosed[index];
      const { tab, groupId: originalGroupId, index: originalIndex } = closedTab;

      // Check if original group still exists, otherwise use active group
      const targetGroupId = state.tabGroups[originalGroupId]
        ? originalGroupId
        : state.activeGroupId;
      const targetGroup = state.tabGroups[targetGroupId];

      if (!targetGroup) return state;

      const newTab = {
        ...tab,
        id: generateId(),
        openedAt: Date.now(),
        lastAccessedAt: Date.now(),
        isPreview: false,
      };

      const insertIndex = Math.min(originalIndex, targetGroup.tabs.length);
      const newTabs = [
        ...targetGroup.tabs.slice(0, insertIndex),
        newTab,
        ...targetGroup.tabs.slice(insertIndex),
      ];

      // Remove from recently closed
      const remainingClosed = state.recentlyClosed.filter((_, i) => i !== index);

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [targetGroupId]: {
            ...targetGroup,
            tabs: newTabs,
            activeTabId: newTab.id,
          },
        },
        recentlyClosed: remainingClosed,
        activeGroupId: targetGroupId,
      };
    }

    case 'CLEAR_RECENTLY_CLOSED': {
      return {
        ...state,
        recentlyClosed: [],
      };
    }

    // =========================================================================
    // SPLIT VIEW ACTIONS
    // =========================================================================

    case 'SPLIT_VIEW': {
      const { direction, groupId } = action.payload;

      if (!state.tabGroups[groupId]) return state;

      const newGroup = createEmptyTabGroup(true);

      // Update layout
      const newLayout = insertSplitAtGroup(
        state.layout,
        groupId,
        newGroup.id,
        direction
      );

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [newGroup.id]: newGroup,
        },
        layout: newLayout,
      };
    }

    case 'RESIZE_SPLIT': {
      const { path, ratio } = action.payload;

      // Clamp ratio between 0.1 and 0.9
      const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));

      const updateRatio = (layout: typeof state.layout, depth: number): typeof state.layout => {
        if (layout.type === 'leaf') return layout;
        if (depth === path.length) {
          return { ...layout, ratio: clampedRatio };
        }
        if (path[depth] === 0) {
          return { ...layout, first: updateRatio(layout.first, depth + 1) };
        }
        return { ...layout, second: updateRatio(layout.second, depth + 1) };
      };

      return {
        ...state,
        layout: updateRatio(state.layout, 0),
      };
    }

    case 'CLOSE_SPLIT': {
      const { groupId } = action.payload;

      if (Object.keys(state.tabGroups).length <= 1) return state;

      return closeGroup(state, groupId, state.recentlyClosed);
    }

    case 'MOVE_TAB_TO_NEW_SPLIT': {
      const { tabId, fromGroupId, direction } = action.payload;
      const fromGroup = state.tabGroups[fromGroupId];

      if (!fromGroup) return state;

      const tab = fromGroup.tabs.find((t) => t.id === tabId);
      if (!tab) return state;

      // Don't allow if it's the only tab in the only group
      if (fromGroup.tabs.length === 1 && Object.keys(state.tabGroups).length === 1) {
        return state;
      }

      // Create new group with the tab
      const newGroup: TabGroup = {
        id: generateId(),
        tabs: [{ ...tab, lastAccessedAt: Date.now() }],
        activeTabId: tab.id,
        isActive: false,
      };

      // Remove tab from source
      const newFromTabs = fromGroup.tabs.filter((t) => t.id !== tabId);

      // Map direction to split type
      const splitDirection: 'horizontal' | 'vertical' =
        direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';

      // Determine layout order
      const isFirst = direction === 'left' || direction === 'up';

      // Update layout
      const insertSplit = (layout: typeof state.layout): typeof state.layout => {
        if (layout.type === 'leaf' && layout.tabGroupId === fromGroupId) {
          return {
            type: splitDirection,
            ratio: 0.5,
            first: isFirst
              ? { type: 'leaf', tabGroupId: newGroup.id }
              : { type: 'leaf', tabGroupId: fromGroupId },
            second: isFirst
              ? { type: 'leaf', tabGroupId: fromGroupId }
              : { type: 'leaf', tabGroupId: newGroup.id },
          };
        }
        if (layout.type !== 'leaf') {
          return {
            ...layout,
            first: insertSplit(layout.first),
            second: insertSplit(layout.second),
          };
        }
        return layout;
      };

      // Handle source group becoming empty
      if (newFromTabs.length === 0) {
        // Replace the source group's position with new group
        return {
          ...state,
          tabGroups: {
            ...state.tabGroups,
            [newGroup.id]: { ...newGroup, isActive: true },
          },
          layout: {
            type: 'leaf',
            tabGroupId: newGroup.id,
          },
          activeGroupId: newGroup.id,
        };
      }

      // Update active tab in source
      let newFromActiveTabId = fromGroup.activeTabId;
      if (fromGroup.activeTabId === tabId) {
        const oldIndex = fromGroup.tabs.findIndex((t) => t.id === tabId);
        const newIndex = Math.min(oldIndex, newFromTabs.length - 1);
        newFromActiveTabId = newFromTabs[newIndex].id;
      }

      return {
        ...state,
        tabGroups: {
          ...state.tabGroups,
          [fromGroupId]: {
            ...fromGroup,
            tabs: newFromTabs,
            activeTabId: newFromActiveTabId,
          },
          [newGroup.id]: newGroup,
        },
        layout: insertSplit(state.layout),
        activeGroupId: newGroup.id,
      };
    }

    // =========================================================================
    // SETTINGS ACTIONS
    // =========================================================================

    case 'UPDATE_SETTINGS': {
      return {
        ...state,
        settings: {
          ...state.settings,
          ...action.payload,
        },
      };
    }

    // =========================================================================
    // SESSION ACTIONS
    // =========================================================================

    case 'RESTORE_SESSION': {
      return action.payload;
    }

    case 'RESET_TO_DEFAULT': {
      return createInitialState();
    }

    case 'SET_LAYOUT': {
      const { tabGroups, layout, activeGroupId } = action.payload;
      return {
        ...state,
        tabGroups,
        layout,
        activeGroupId,
      };
    }

    default:
      return state;
  }
}
