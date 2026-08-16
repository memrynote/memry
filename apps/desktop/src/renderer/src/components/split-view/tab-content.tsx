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
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useTasksOptional } from '@/contexts/tasks'
import { cn } from '@/lib/utils'
import { InboxPage } from '@/pages/inbox'
import { useT } from '@memry/i18n/renderer'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import type { ViewScope } from '@memry/contracts/folder-view-api'

// =============================================================================
// MEMOIZED PAGE COMPONENTS
// Prevents recreation on every render - crucial for performance
// =============================================================================

const MemoizedInboxPage = React.memo(InboxPage)
const LazyCalendarPage = React.lazy(async () => ({
  default: (await import('@/pages/calendar')).CalendarPage
}))
const LazyJournalPage = React.lazy(async () => ({
  default: (await import('@/pages/journal')).JournalPage
}))
const LazyTasksPage = React.lazy(async () => ({
  default: (await import('@/pages/tasks')).TasksPage
}))
const LazyNotePage = React.lazy(async () => ({
  default: (await import('@/pages/note')).NotePage
}))
const LazyFilePage = React.lazy(async () => ({
  default: (await import('@/pages/file')).FilePage
}))
const LazyFolderViewPage = React.lazy(async () => ({
  default: (await import('@/pages/folder-view')).FolderViewPage
}))
const LazyTemplateEditorPage = React.lazy(async () => ({
  default: (await import('@/pages/template-editor')).TemplateEditorPage
}))
const LazyGraphPage = React.lazy(async () => ({
  default: (await import('@/components/graph/graph-page')).GraphPage
}))
const LazyTagsHubPage = React.lazy(async () => ({
  default: (await import('@/pages/tags-hub')).TagsHubPage
}))
const LazyAgentConversationTab = React.lazy(async () => ({
  default: (await import('@/agent-chat/agent-conversation-tab')).AgentConversationTab
}))
const LazyCanvasPage = React.lazy(async () => ({
  default: (await import('@/pages/canvas')).CanvasPage
}))
const LazyVirtualNotePage = React.lazy(async () => ({
  default: (await import('@/pages/virtual-note')).VirtualNotePage
}))
const LazyHomePage = React.lazy(() => import('@/pages/home'))
const LazyProjectPage = React.lazy(async () => ({
  default: (await import('@/pages/project')).ProjectPage
}))

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
  const { t: tPhaseF } = useT('common')
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

  // FolderViewPage's `useFolderView` keys its live-refresh subscriptions off
  // scope identity — memoized here (independent of the broader `content`
  // memo below, whose deps include `tasksContext` and can recompute more
  // often) so scope stays referentially stable across renders that don't
  // actually change the folder/tag.
  const folderScope = useMemo<ViewScope>(
    () => ({ kind: 'folder', path: tab.entityId ?? '' }),
    [tab.entityId]
  )
  const tagScope = useMemo<ViewScope>(
    () => ({ kind: 'tag', tag: tab.entityId ?? '' }),
    [tab.entityId]
  )

  // PERFORMANCE: Memoize content based on tab identity to prevent remounting
  // Key insight: useMemo ensures React reuses the component instance when
  // only unrelated state changes (like other tabs being modified)
  const content = useMemo((): React.ReactNode => {
    switch (tab.type) {
      case 'home':
        return <LazyHomePage />

      case 'inbox':
        return <MemoizedInboxPage />

      case 'calendar':
        return <LazyCalendarPage />

      case 'project':
        return <LazyProjectPage projectId={tab.entityId} />

      case 'tasks':
      case 'all-tasks':
      case 'today':
      case 'completed': {
        // Use TasksContext if available
        if (tasksContext) {
          // Determine selection based on tab type
          const selectionId = tab.type === 'all-tasks' || tab.type === 'tasks' ? 'all' : tab.type
          const selectionType = 'view'

          return (
            <LazyTasksPage
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
            <p className="text-sm text-gray-400">
              {tPhaseF('phaseF.componentsSplitViewTabContent.taskscontextNotAvailable')}
            </p>
          </div>
        )
      }

      case 'note':
        return <LazyNotePage noteId={tab.entityId} />

      case 'file':
        return <LazyFilePage fileId={tab.entityId} />

      case 'folder':
        return <LazyFolderViewPage scope={folderScope} />

      case 'journal':
        return <LazyJournalPage />

      case 'search':
        return (
          <PlaceholderView
            title={tPhaseF('phaseF.componentsSplitViewTabContent.searchResults')}
            icon="search"
            subtitle={`Query: ${stringifyUnknown(tab.viewState?.query)}`}
          />
        )

      case 'template-editor':
        return <LazyTemplateEditorPage templateId={tab.entityId} tabId={tab.id} />

      case 'graph':
        return <LazyGraphPage />

      case 'tags':
        return <LazyTagsHubPage />

      case 'tag':
        // Renders the same folder-view page as `case 'folder'`, scoped to a
        // tag instead of a directory (Task 9 of the tag→folder-view
        // migration). `Tab` carries no `color` field (only `SidebarItem`
        // does, and it isn't threaded through `createTabFromSidebarItem`) —
        // the page falls back to a deterministic tag-name color via
        // `getTagColors` when none is given.
        return <LazyFolderViewPage scope={tagScope} />

      case 'agent-chat':
        return <LazyAgentConversationTab conversationId={tab.entityId} />

      case 'canvas':
        // Keyed by entity id: Excalidraw consumes initialData only at mount, so
        // switching between canvas tabs must remount the page. Without the key,
        // the reused editor keeps the previous canvas's scene and its persister
        // saves that scene under the NEW canvas id, overwriting it.
        return <LazyCanvasPage key={tab.entityId} canvasId={tab.entityId} />

      case 'virtual-note':
        return (
          <LazyVirtualNotePage
            title={tab.title}
            content={stringifyUnknown(tab.viewState?.content)}
            contentType={tab.viewState?.contentType === 'markdown' ? 'markdown' : 'html'}
          />
        )

      case 'collection':
        return (
          <PlaceholderView
            title={tab.title}
            icon="bookmark"
            subtitle={`Collection: ${tab.entityId}`}
          />
        )

      default:
        return (
          <div className="p-4 text-gray-500">
            {tPhaseF('phaseF.componentsSplitViewTabContent.unknownTabType')}
            {tab.type}
          </div>
        )
    }
    // Dependencies: tab identity fields and tasksContext for TasksPage props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab.id,
    tab.type,
    tab.entityId,
    tab.title,
    tab.viewState?.query,
    tasksContext,
    folderScope,
    tagScope
  ])

  return (
    <div
      ref={scrollRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      data-tab-content={tab.id}
    >
      <TabIdentityProvider tabId={tab.id} groupId={groupId} entityId={tab.entityId}>
        <React.Suspense fallback={null}>{content}</React.Suspense>
      </TabIdentityProvider>
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
    <div className="h-full flex flex-col items-center justify-center text-text-tertiary p-8">
      <div className="text-6xl mb-4 opacity-30">📄</div>
      <h2 className="text-xl font-medium text-foreground mb-2">{title}</h2>
      {subtitle && <p className="text-sm text-text-tertiary">{subtitle}</p>}
    </div>
  )
}

export default TabContent
