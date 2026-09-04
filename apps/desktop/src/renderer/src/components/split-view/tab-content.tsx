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

import React, { useMemo } from 'react'
import type { Tab } from '@/contexts/tabs/types'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { useTasksOptional } from '@/contexts/tasks'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import type { ViewScope } from '@memry/contracts/folder-view-api'

// =============================================================================
// LAZY PAGE COMPONENTS
// Module-level so each type keeps one stable component identity, and so no
// page's dependency tree lands in the entry chunk.
// =============================================================================

const pageLoaders = {
  home: async () => (await import('@/pages/home')).default,
  inbox: async () => (await import('@/pages/inbox')).InboxPage,
  calendar: async () => (await import('@/pages/calendar')).CalendarPage,
  journal: async () => (await import('@/pages/journal')).JournalPage,
  tasks: async () => (await import('@/pages/tasks')).TasksPage,
  note: async () => (await import('@/pages/note')).NotePage,
  file: async () => (await import('@/pages/file')).FilePage,
  folderView: async () => (await import('@/pages/folder-view')).FolderViewPage,
  templateEditor: async () => (await import('@/pages/template-editor')).TemplateEditorPage,
  graph: async () => (await import('@/components/graph/graph-page')).GraphPage,
  tagsHub: async () => (await import('@/pages/tags-hub')).TagsHubPage,
  agentConversation: async () =>
    (await import('@/agent-chat/agent-conversation-tab')).AgentConversationTab,
  canvas: async () => (await import('@/pages/canvas')).CanvasPage,
  virtualNote: async () => (await import('@/pages/virtual-note')).VirtualNotePage,
  project: async () => (await import('@/pages/project')).ProjectPage
} satisfies Record<string, () => Promise<unknown>>

/**
 * Start a page's chunk fetch before React reaches its lazy boundary, so a
 * restored tab's download overlaps vault open and tab restore instead of
 * queueing behind them. It resolves through the same module registry
 * `React.lazy` reads, so the render-time import is a cache hit, not a
 * second request.
 */
export const prefetchPageModule = (key: string): void => {
  const loader = pageLoaders[key as keyof typeof pageLoaders]
  if (loader) void loader().catch(() => {})
}

const LazyInboxPage = React.lazy(async () => ({ default: await pageLoaders.inbox() }))
const LazyCalendarPage = React.lazy(async () => ({ default: await pageLoaders.calendar() }))
const LazyJournalPage = React.lazy(async () => ({ default: await pageLoaders.journal() }))
const LazyTasksPage = React.lazy(async () => ({ default: await pageLoaders.tasks() }))
const LazyNotePage = React.lazy(async () => ({ default: await pageLoaders.note() }))
const LazyFilePage = React.lazy(async () => ({ default: await pageLoaders.file() }))
const LazyFolderViewPage = React.lazy(async () => ({ default: await pageLoaders.folderView() }))
const LazyTemplateEditorPage = React.lazy(async () => ({
  default: await pageLoaders.templateEditor()
}))
const LazyGraphPage = React.lazy(async () => ({ default: await pageLoaders.graph() }))
const LazyTagsHubPage = React.lazy(async () => ({ default: await pageLoaders.tagsHub() }))
const LazyAgentConversationTab = React.lazy(async () => ({
  default: await pageLoaders.agentConversation()
}))
const LazyCanvasPage = React.lazy(async () => ({ default: await pageLoaders.canvas() }))
const LazyVirtualNotePage = React.lazy(async () => ({ default: await pageLoaders.virtualNote() }))
const LazyHomePage = React.lazy(async () => ({ default: await pageLoaders.home() }))
const LazyProjectPage = React.lazy(async () => ({ default: await pageLoaders.project() }))

interface TabContentProps {
  /** Tab data */
  tab: Tab
  /** Group ID this tab belongs to */
  groupId: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Renders the appropriate view for a tab type, and publishes the tab's identity
 * so the page inside can scope its own state (scroll offset, view state) to it.
 */
export const TabContent = ({ tab, groupId, className }: TabContentProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('common')
  const tasksContext = useTasksOptional()

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
        return <LazyInboxPage />

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
    // Layout only: pages own their scrolling (see `useTabScrollRestore`). The
    // overflow rules stay because a page that is not `h-full`/`overflow-hidden`
    // would otherwise spill out of the pane.
    <div
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
