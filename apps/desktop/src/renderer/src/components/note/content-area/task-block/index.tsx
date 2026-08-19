import { createReactBlockSpec } from '@blocknote/react'
import { taskBlockConfig } from '@memry/editor-schema/blocks'
import {
  TaskBlockRenderer,
  type TaskBlock,
  type TaskBlockEditor,
  type TaskBlockInlineContent
} from './task-block-renderer'
import { tasksService } from '@/services/tasks-service'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { formatDateKey } from '@/lib/task-utils'
import type { Project } from '@/data/tasks-data'

const PRIORITY_REVERSE: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

// Type/props/content come from the shared config so the renderer's block and
// the main process's headless twin cannot disagree; only the React
// presentation is declared here.
export const createTaskBlock = createReactBlockSpec(taskBlockConfig, {
  render: (props) => (
    <TaskBlockRenderer
      block={props.block as TaskBlock}
      editor={props.editor}
      contentRef={props.contentRef}
    />
  )
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

      const res = await tasksService.listProjects()
      const projects = res.projects ?? []
      const defaultProject =
        projects.find(
          (p) =>
            ('isDefault' in p && Boolean(p.isDefault)) || ('isInbox' in p && Boolean(p.isInbox))
        ) ?? projects[0]
      if (!defaultProject) return

      const parsed = text
        ? parseQuickAdd(text, projects as unknown as Project[])
        : { title: '', priority: 'none' as const, projectId: null, dueDate: null }

      const result = await tasksService.create({
        projectId: parsed.projectId ?? defaultProject.id,
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
    },
    aliases: ['task', 'todo', 'action'],
    group: 'Basic blocks',
    subtext: 'Create a linked task'
  }
}
