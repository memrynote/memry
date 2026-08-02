import type { ProjectLinkedEvent } from '@memry/rpc/tasks'
import type { Priority } from '@/data/task-model'
import type { ProjectTabKey } from '../use-project-hub'

/**
 * Every interaction the hub's rows and sections can raise. Defined once so the
 * overview previews and the full tabs stay behaviourally identical — a row
 * clicked in the preview does exactly what the same row does in its own tab.
 */
export interface HubHandlers {
  onGoToTab: (tab: ProjectTabKey) => void
  onOpenTask: (taskId: string) => void
  onStatusChange: (taskId: string, statusId: string) => void
  onToggleComplete: (taskId: string) => void
  onPriorityChange: (taskId: string, priority: Priority) => void
  onOpenNote: (noteId: string) => void
  onNoteIconChange: (noteId: string, icon: string | null) => void
  onOpenFile: (fileId: string) => void
  onOpenEvent: (event: ProjectLinkedEvent) => void
  onAddTask: () => void
  onAddNote: () => void
  onAddFile: () => void
  onAddEvent: () => void
}
