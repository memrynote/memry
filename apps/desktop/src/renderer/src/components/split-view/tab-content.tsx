/**
 * Tab Content Component
 * Routes to the correct view based on tab type
 *
 * PERFORMANCE: Page components are memoized to prevent unnecessary remounting
 * when tab state changes. This is critical because:
 * 1. Pages have 15-30+ hooks that run on mount
 * 2. Without memoization, switching tabs causes full page remounts
 * 3. useMemo with tab.id key ensures content is cached per tab instance
 */

import React, { useRef, useEffect, useMemo } from 'react'
import type { Tab } from '@/contexts/tabs/types'
import { useTabActions } from '@/contexts/tabs'
import { useTasksOptional } from '@/contexts/tasks'
import { cn } from '@/lib/utils'
import { InboxPage } from '@/pages/inbox'
import { JournalPage } from '@/pages/journal'
import { TasksPage } from '@/pages/tasks'
import { NotePage } from '@/pages/note'
import { FilePage } from '@/pages/file'
import { FolderViewPage } from '@/pages/folder-view'
import { SettingsPage } from '@/pages/settings'
import { TemplateEditorPage } from '@/pages/template-editor'
import { TemplatesPage } from '@/pages/templates'

// =============================================================================
// MEMOIZED PAGE COMPONENTS
// Prevents recreation on every render - crucial for performance
// =============================================================================

const MemoizedInboxPage = React.memo(InboxPage)
const MemoizedJournalPage = React.memo(JournalPage)
const MemoizedTasksPage = React.memo(TasksPage)
const MemoizedNotePage = React.memo(NotePage)
const MemoizedFilePage = React.memo(FilePage)
const MemoizedFolderViewPage = React.memo(FolderViewPage)
const MemoizedSettingsPage = React.memo(SettingsPage)
const MemoizedTemplateEditorPage = React.memo(TemplateEditorPage)
const MemoizedTemplatesPage = React.memo(TemplatesPage)

interface TabContentProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Renders the appropriate view for a tab type
 * PERFORMANCE: Uses useTabActions instead of useTabs to avoid re-renders on state changes
 */
export const TabContent = ({ tab, groupId, className }: TabContentProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null)
  // PERFORMANCE: useTabActions returns stable references - doesn't cause re-renders
  const { dispatch } = useTabActions()
  const tasksContext = useTasksOptional()

  // Save scroll position on unmount or tab change
  useEffect(() => {
    const scrollElement = scrollRef.current

    return () => {
      if (scrollElement) {
        dispatch({
          type: 'SAVE_TAB_STATE',
          payload: {
            tabId: tab.id,
            groupId,
            scrollPosition: scrollElement.scrollTop
          }
        })
      }
    }
  }, [tab.id, groupId, dispatch])

  // Restore scroll position on mount
  useEffect(() => {
    if (scrollRef.current && tab.scrollPosition) {
      scrollRef.current.scrollTop = tab.scrollPosition
    }
  }, [tab.id, tab.scrollPosition])

  // PERFORMANCE: Memoize content based on tab identity to prevent remounting
  // Key insight: useMemo ensures React reuses the component instance when
  // only unrelated state changes (like other tabs being modified)
  const content = useMemo((): React.ReactNode => {
    switch (tab.type) {
      case 'inbox':
        return <MemoizedInboxPage />

      case 'home':
        return <PlaceholderView title="Home" icon="home" />

      case 'tasks':
      case 'all-tasks':
      case 'today':
      case 'completed':
      case 'project': {
        // Use TasksContext if available
        if (tasksContext) {
          // Determine selection based on tab type
          const selectionId =
            tab.type === 'project'
              ? tab.entityId || 'personal'
              : tab.type === 'all-tasks' || tab.type === 'tasks'
                ? 'all'
                : tab.type
          const selectionType = tab.type === 'project' ? 'project' : 'view'

          return (
            <MemoizedTasksPage
              selectedId={selectionId}
              selectedType={selectionType}
              tasks={tasksContext.tasks}
              projects={tasksContext.projects}
              onTasksChange={tasksContext.setTasks}
              onSelectionChange={tasksContext.setSelection}
              selectedTaskIds={tasksContext.selectedTaskIds}
              onSelectedTaskIdsChange={tasksContext.setSelectedTaskIds}
            />
          )
        }
        // Fallback if context not available
        return (
          <div className="h-full p-4 text-gray-500">
            <div className="text-lg font-medium mb-2">{tab.title}</div>
            <p className="text-sm text-gray-400">TasksContext not available</p>
          </div>
        )
      }

      case 'note':
        return <MemoizedNotePage noteId={tab.entityId} />

      case 'file':
        return <MemoizedFilePage fileId={tab.entityId} />

      case 'folder':
        return <MemoizedFolderViewPage folderPath={tab.entityId} />

      case 'journal':
        return <MemoizedJournalPage />

      case 'search':
        return (
          <PlaceholderView
            title="Search Results"
            icon="search"
            subtitle={`Query: ${tab.viewState?.query ?? ''}`}
          />
        )

      case 'settings':
        return <MemoizedSettingsPage />

      case 'template-editor':
        return <MemoizedTemplateEditorPage templateId={tab.entityId} />

      case 'templates':
        return <MemoizedTemplatesPage />

      case 'collection':
        return (
          <PlaceholderView
            title={tab.title}
            icon="bookmark"
            subtitle={`Collection: ${tab.entityId}`}
          />
        )

      default:
        return <div className="p-4 text-gray-500">Unknown tab type: {tab.type}</div>
    }
    // Dependencies: tab identity fields and tasksContext for TasksPage props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.type, tab.entityId, tab.title, tab.viewState?.query, tasksContext])

  return (
    <div
      ref={scrollRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      data-tab-content={tab.id}
    >
      {content}
    </div>
  )
}

// =============================================================================
// PLACEHOLDER VIEW (for tab types not yet implemented)
// =============================================================================

interface PlaceholderViewProps {
  title: string
  icon: string
  subtitle?: string
}

const PlaceholderView = ({
  title,
  icon: _icon,
  subtitle
}: PlaceholderViewProps): React.JSX.Element => {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 p-8">
      <div className="text-6xl mb-4 opacity-30">📄</div>
      <h2 className="text-xl font-medium text-gray-600 dark:text-gray-300 mb-2">{title}</h2>
      {subtitle && <p className="text-sm text-gray-400 dark:text-gray-500">{subtitle}</p>}
    </div>
  )
}

export default TabContent
