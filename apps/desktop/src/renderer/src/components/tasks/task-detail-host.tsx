import React, { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useTabActions } from '@/contexts/tabs'
import type { Tab } from '@/contexts/tabs/types'

type OpenTab = (tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>) => void
type OpenTaskDetail = (taskId: string) => void

const TaskDetailHostContext = createContext<OpenTaskDetail | null>(null)

// Lazy because TabContent sits in the entry chunk and the drawer pulls in the
// BlockNote description editor; it loads on the first open instead.
const HostedTaskDetailDrawer = React.lazy(async () => ({
  default: (await import('./hosted-task-detail-drawer')).HostedTaskDetailDrawer
}))

export const openTaskInTasksTab = (
  openTab: OpenTab,
  taskId: string,
  projectId?: string | null
): void => {
  openTab({
    type: 'tasks',
    title: 'Tasks',
    icon: 'list-checks',
    path: '/tasks',
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    viewState: {
      openTaskId: taskId,
      selectedProjectId: projectId ?? undefined,
      activeTab: 'all'
    }
  })
}

/**
 * Opens a task's detail drawer over the tab it is called from. Outside a host
 * there is no pane to open it in, so it falls back to the Tasks tab.
 */
export const useOpenTaskDetail = (): OpenTaskDetail => {
  const openInHost = useContext(TaskDetailHostContext)
  const { openTab } = useTabActions()
  const openInTasks = useCallback(
    (taskId: string) => openTaskInTasksTab(openTab, taskId),
    [openTab]
  )
  return openInHost ?? openInTasks
}

/** One per tab: the task detail drawer any surface in the tab can open in place. */
export const TaskDetailHost = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const close = useCallback(() => setOpenTaskId(null), [])

  return (
    <TaskDetailHostContext.Provider value={setOpenTaskId}>
      {children}
      {openTaskId && (
        <React.Suspense fallback={null}>
          <HostedTaskDetailDrawer taskId={openTaskId} onClose={close} />
        </React.Suspense>
      )}
    </TaskDetailHostContext.Provider>
  )
}
