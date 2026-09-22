import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { useT } from '@memry/i18n/renderer'
import { useProjectsList } from '@/hooks/use-projects-list'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('NoteProjectTaskMove')

export interface NoteTaskMovePrompt {
  projectId: string
  projectName: string
  taskIds: string[]
}

export interface UseNoteProjectTaskMoveResult {
  prompt: NoteTaskMovePrompt | null
  isMoving: boolean
  /** Call with the `project` property's value before and after the edit. */
  handleProjectPropertyChange: (previousValue: unknown, nextValue: unknown) => void
  confirmMove: () => void
  cancelMove: () => void
}

/**
 * Tolerates every shape the `project` frontmatter value takes: a name list, a
 * single name, or nothing. Mirrors `main/notes/project-property.readProjectNames`,
 * which the renderer cannot import across the process boundary.
 */
function toProjectNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== ''
    )
  }
  if (typeof value === 'string' && value.trim() !== '') return [value]
  return []
}

/**
 * Offer to move the tasks written in a note when the note is given a project
 * (#2271).
 *
 * New tasks typed in the note follow its `project` property, but the ones
 * already in it keep whatever project they were created in — usually the inbox,
 * from before the note named a project. That leaves one note's checklist split
 * across two projects with nothing saying so, so the change offers to bring
 * them along. Removing a project never prompts: it names no destination.
 */
export function useNoteProjectTaskMove(
  noteId: string | null,
  noteContent: string
): UseNoteProjectTaskMoveResult {
  const { t } = useT('notes')
  const { projects } = useProjectsList()
  const [prompt, setPrompt] = useState<NoteTaskMovePrompt | null>(null)
  const [isMoving, setIsMoving] = useState(false)

  // The body is read only when the user changes the property, so the callback
  // reads it through a ref rather than being rebuilt on every keystroke.
  const contentRef = useRef(noteContent)
  useEffect(() => {
    contentRef.current = noteContent
  }, [noteContent])

  const handleProjectPropertyChange = useCallback(
    (previousValue: unknown, nextValue: unknown): void => {
      if (!noteId) return

      const before = new Set(toProjectNames(previousValue).map((name) => name.toLowerCase()))
      const added = toProjectNames(nextValue).filter((name) => !before.has(name.toLowerCase()))
      if (added.length === 0) return

      // Frontmatter stores names, and an archived project is not somewhere to
      // move live tasks into.
      const target = projects.find(
        (project) =>
          project.archivedAt == null && project.name.toLowerCase() === added[0].toLowerCase()
      )
      if (!target) return

      void (async () => {
        try {
          // `{task:<id>}` lines are the tasks this note actually holds; a task
          // merely linked to it from the task detail panel is not one of them.
          const idsInNote = scanTaskCheckboxStates(contentRef.current)
          if (idsInNote.size === 0) return

          const linked = await tasksService.getLinkedTasks(noteId)
          const candidates = Array.isArray(linked)
            ? linked.filter(
                (task) => idsInNote.has(task.id) && !task.parentId && task.projectId !== target.id
              )
            : []
          if (candidates.length === 0) return

          setPrompt({
            projectId: target.id,
            projectName: target.name,
            taskIds: candidates.map((task) => task.id)
          })
        } catch (error) {
          // Nothing was written, and the property change itself succeeded —
          // the prompt is an offer, not part of that edit.
          log.warn('Failed to look for note tasks to move', error)
        }
      })()
    },
    [noteId, projects]
  )

  const confirmMove = useCallback((): void => {
    if (!prompt || isMoving) return
    setIsMoving(true)

    void (async () => {
      try {
        for (const taskId of prompt.taskIds) {
          const result = await tasksService.update({ id: taskId, projectId: prompt.projectId })
          if (!result.success) throw new Error(result.error ?? 'Task move failed')

          // Nothing else moves subtasks with their parent, and a subtask left
          // behind is filed under a project its parent no longer belongs to.
          const subtasks = await tasksService.getSubtasks(taskId)
          if (!Array.isArray(subtasks)) continue
          for (const subtask of subtasks) {
            if (subtask.projectId === prompt.projectId) continue
            const moved = await tasksService.update({
              id: subtask.id,
              projectId: prompt.projectId
            })
            // Reported, not swallowed: a child that stayed behind is exactly
            // the split this loop exists to prevent, so it must not end in a
            // success toast.
            if (!moved.success) throw new Error(moved.error ?? 'Task move failed')
          }
        }
        toast.success(
          t('moveNoteTasks.success', {
            count: prompt.taskIds.length,
            project: prompt.projectName
          })
        )
      } catch (error) {
        toast.error(extractErrorMessage(error, t('moveNoteTasks.failed')))
      } finally {
        setIsMoving(false)
        setPrompt(null)
      }
    })()
  }, [prompt, isMoving, t])

  const cancelMove = useCallback((): void => {
    if (isMoving) return
    setPrompt(null)
  }, [isMoving])

  return { prompt, isMoving, handleProjectPropertyChange, confirmMove, cancelMove }
}
