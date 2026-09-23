import { createReactBlockSpec } from '@blocknote/react'
import { taskBlockConfig } from '@memry/editor-schema/blocks'
import {
  TaskBlockRenderer,
  type TaskBlock,
  type TaskBlockEditor,
  type TaskBlockInlineContent
} from './task-block-renderer'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { resolveProjectIdForNoteTask } from '@/lib/note-task-project'
import { formatDateKey } from '@/lib/task-utils'
import type { Project } from '@/data/tasks-data'

const PRIORITY_REVERSE: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

// Type/props/content come from the shared config so the renderer's block and
// the main process's headless twin cannot disagree; only the React
// presentation is declared here.
export const createTaskBlock = createReactBlockSpec(taskBlockConfig, {
  render: (props) => <TaskBlockRenderer block={props.block as TaskBlock} editor={props.editor} />
})

export function getTaskSlashMenuItem(editor: unknown, noteId?: string) {
  return {
    title: 'Task',
    onItemClick: async () => {
      const taskEditor = editor as TaskBlockEditor & {
        getBlock: (id: string) => TaskBlock | undefined
      }
      const currentBlock = taskEditor.getTextCursorPosition().block
      const blockId = currentBlock.id
      const content = currentBlock.content ?? []
      const text =
        content
          .map((c: TaskBlockInlineContent) => (typeof c === 'string' ? c : (c.text ?? '')))
          .join('')
          .trim() || ''

      // Convert the block to a taskBlock immediately — same as the
      // checklist→task conversion — so the user always sees a task even if the
      // backing task creation below is slow, fails, or has no project yet.
      taskEditor.updateBlock(currentBlock, {
        type: 'taskBlock',
        props: { taskId: '', title: text, checked: false }
      })

      // `/task` on an empty line is the normal way to start one, so there is
      // nothing to create yet. The block above is now a draft taskBlock with an
      // empty `taskId`; ContentArea's draft scan picks it up and creates the row
      // as soon as the user types a title. Calling `tasks:create` with `''` here
      // only earns a contract rejection the user never asked for (#1991).
      if (!text) return

      const res = await tasksService.listProjects()
      const projects = res.projects ?? []

      // SAFETY: the parser only reads `id` and `name` off each project, which
      // the IPC shape and the renderer view model spell identically; the rest
      // of the view model (statuses, counts) is never touched.
      const parsed = parseQuickAdd(text, projects as unknown as Project[])
      // Quick-add lifts its own tokens off the line, so a line of nothing but
      // tokens ("#tag", "!!high") leaves no title behind. Same draft handoff as
      // the empty-line case above.
      if (!parsed.title.trim()) return

      // The note's own project decides where `/task` lands (#2271).
      const projectId = await resolveProjectIdForNoteTask({
        noteId,
        quickAddProjectId: parsed.projectId,
        projects
      })
      if (!projectId) return

      try {
        const result = await tasksService.create({
          projectId,
          title: parsed.title,
          priority: PRIORITY_REVERSE[parsed.priority] ?? 0,
          dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null,
          linkedNoteIds: noteId ? [noteId] : []
        })
        if (result.success && result.task) {
          // Re-fetch fresh: the block reference captured before the awaits above
          // may be stale by now.
          const freshBlock = taskEditor.getBlock(blockId) ?? currentBlock
          const currentTitle = freshBlock.props?.title || parsed.title || text
          taskEditor.updateBlock(freshBlock, {
            type: 'taskBlock',
            props: { taskId: result.task.id, title: currentTitle, checked: false }
          })
          if (currentTitle && currentTitle !== result.task.title) {
            void tasksService.update({ id: result.task.id, title: currentTitle })
          }
        }
      } catch (err) {
        // Without this the rejection was unhandled and the block sat there
        // looking like a real task with no row behind it.
        toast.error(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToCreateTask')
          )
        )
      }
    },
    aliases: ['task', 'todo', 'action'],
    group: 'Basic blocks',
    subtext: 'Create a linked task'
  }
}
