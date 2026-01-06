/**
 * Tab Content Component
 * Routes to the correct view based on tab type
 */

import { useRef, useEffect } from 'react'
import type { Tab } from '@/contexts/tabs/types'
import { useTabs } from '@/contexts/tabs'
import { useTasksOptional } from '@/contexts/tasks'
import { cn } from '@/lib/utils'
import { InboxPage } from '@/pages/inbox'
import { JournalPage } from '@/pages/journal'
import { TasksPage } from '@/pages/tasks'
import { NotePage } from '@/pages/note'
import { FolderViewPage } from '@/pages/folder-view'
import { SettingsPage } from '@/pages/settings'
import { TemplateEditorPage } from '@/pages/template-editor'
import { TemplatesPage } from '@/pages/templates'

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
 */
export const TabContent = ({ tab, groupId, className }: TabContentProps): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { dispatch } = useTabs()
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

  // Render content based on tab type
  const renderContent = (): React.ReactNode => {
    switch (tab.type) {
      case 'inbox':
        return <InboxPage />

      case 'home':
        return <PlaceholderView title="Home" icon="home" />

      case 'tasks':
      case 'all-tasks':
      case 'today':
      case 'upcoming':
      case 'completed':
      case 'project':
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
            <TasksPage
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

      case 'note':
        return <NotePage noteId={tab.entityId} />

      case 'folder':
        return <FolderViewPage folderPath={tab.entityId} />

      case 'journal':
        return <JournalPage />

      case 'search':
        return (
          <PlaceholderView
            title="Search Results"
            icon="search"
            subtitle={`Query: ${tab.viewState?.query ?? ''}`}
          />
        )

      case 'settings':
        return <SettingsPage />

      case 'template-editor':
        return <TemplateEditorPage templateId={tab.entityId} />

      case 'templates':
        return <TemplatesPage />

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
  }

  return (
    <div
      ref={scrollRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      data-tab-content={tab.id}
    >
      {renderContent()}
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
