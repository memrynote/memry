import { useCallback } from 'react'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { newItemViewState } from '@/contexts/tabs/helpers'
import type { TabType } from '@/contexts/tabs/types'
import type { AppPage } from '@/App'
import { useSidebarNavigation, type OpenSidebarItemOptions } from './use-sidebar-navigation'

export type NavigablePage = AppPage | 'tags'

export interface NavigateToPageOptions extends OpenSidebarItemOptions {
  /** Replaces the page's own view state, e.g. to ask Calendar for a new event. */
  viewState?: Record<string, unknown>
}

// Land the user ready-to-act: Inbox focuses capture, Tasks opens the default
// project + focuses quick-add. Calendar deliberately gets NO new-event popover
// from a plain navigation: that only fires from the New menu and the new-tab +.
const PAGES: Record<
  NavigablePage,
  { type: TabType; title: string; viewState?: () => Record<string, unknown> }
> = {
  home: { type: 'home', title: 'Home' },
  inbox: { type: 'inbox', title: 'Inbox', viewState: () => newItemViewState('inbox') },
  calendar: { type: 'calendar', title: 'Calendar' },
  journal: { type: 'journal', title: 'Journal' },
  tasks: { type: 'tasks', title: 'Tasks', viewState: () => newItemViewState('tasks') },
  graph: { type: 'graph', title: 'Graph' },
  tags: { type: 'tags', title: 'Tags' }
}

/**
 * Open a top-level page as a tab. Shared by the sidebar's clicks, its
 * ⌘/Ctrl+number shortcuts, its New menu and the `go.*` / `create.*` commands, so
 * each lands the user in exactly the same state.
 */
export function useNavigateToPage(): (
  page: NavigablePage,
  options?: NavigateToPageOptions
) => void {
  const { openSidebarItem } = useSidebarNavigation()
  const { isOpen: isSettingsOpen, close: closeSettings } = useSettingsModal()

  return useCallback(
    (page, { viewState, ...openOptions } = {}) => {
      // Settings covers the workspace; going to a page leaves it, even when the
      // page's tab is already the active one.
      if (isSettingsOpen) closeSettings()

      const { type, title, viewState: defaultViewState } = PAGES[page]
      openSidebarItem(
        { type, title, path: `/${page}`, viewState: viewState ?? defaultViewState?.() },
        openOptions
      )
    },
    [openSidebarItem, isSettingsOpen, closeSettings]
  )
}
