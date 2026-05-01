import { createReactBlockSpec } from '@blocknote/react'
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

export const createTaskBlock = createReactBlockSpec(
  {
    type: 'taskBlock' as const,
    propSchema: {
      taskId: { default: '' },
      title: { default: '' },
      checked: { default: false },
      parentTaskId: { default: '' }
    },
    content: 'none'
  },
  {
    render: (props) => (
      <TaskBlockRenderer
        block={props.block as TaskBlock}
        editor={props.editor}
        contentRef={props.contentRef}
      />
    )
  }
)

export function getTaskSlashMenuItem(editor: unknown) {
  return {
    title: 'Task',
    onItemClick: async () => {
      const taskEditor = editor as TaskBlockEditor
      const currentBlock = taskEditor.getTextCursorPosition().block
      const content = currentBlock.content ?? []
      const text =
        content
          .map((c: TaskBlockInlineContent) => (typeof c === 'string' ? c : (c.text ?? '')))
          .join('')
          .trim() || ''

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
        dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null
      })
      if (result.success && result.task) {
        taskEditor.updateBlock(currentBlock, {
          type: 'taskBlock',
          props: { taskId: result.task.id, title: parsed.title, checked: false }
        })
      }
    },
    aliases: ['task', 'todo', 'action'],
    group: 'Basic blocks',
    subtext: 'Create a linked task'
  }
}
