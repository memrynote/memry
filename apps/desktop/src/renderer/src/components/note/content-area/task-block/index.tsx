import { createReactBlockSpec } from '@blocknote/react'
import { TaskBlockRenderer } from './task-block-renderer'
import { tasksService } from '@/services/tasks-service'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { formatDateKey } from '@/lib/task-utils'

const PRIORITY_REVERSE: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

export const createTaskBlock = createReactBlockSpec(
  {
    type: 'taskBlock' as const,
    propSchema: {
      taskId: { default: '' },
      title: { default: '' },
      checked: { default: false }
    },
    content: 'none'
  },
  {
    render: (props) => (
      <TaskBlockRenderer
        block={props.block as any}
        editor={props.editor}
        contentRef={props.contentRef}
      />
    )
  }
)

export function getTaskSlashMenuItem(editor: any) {
  return {
    title: 'Task',
    onItemClick: async () => {
      const currentBlock = editor.getTextCursorPosition().block
      const content = currentBlock.content as any[]
      const text =
        content
          ?.map((c: any) => (typeof c === 'string' ? c : (c.text ?? '')))
          .join('')
          .trim() || 'New task'

      const res = await tasksService.listProjects()
      const projects = res.projects ?? []
      const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
      if (!defaultProject) return

      const parsed = parseQuickAdd(text, projects as any[])

      const result = await tasksService.create({
        projectId: parsed.projectId ?? defaultProject.id,
        title: parsed.title,
        priority: PRIORITY_REVERSE[parsed.priority] ?? 0,
        dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null
      })
      if (result.success && result.task) {
        editor.updateBlock(currentBlock, {
          type: 'taskBlock' as any,
          props: { taskId: result.task.id, title: parsed.title, checked: false }
        })
      }
    },
    aliases: ['task', 'todo', 'action'],
    group: 'Basic blocks',
    subtext: 'Create a linked task'
  }
}
