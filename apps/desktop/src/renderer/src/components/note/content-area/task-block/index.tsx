import { createReactBlockSpec } from '@blocknote/react'
import { TaskBlockRenderer } from './task-block-renderer'

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
    onItemClick: () => {
      const currentBlock = editor.getTextCursorPosition().block
      editor.updateBlock(currentBlock, {
        type: 'taskBlock' as any,
        props: { taskId: '', title: '', checked: false }
      })
      window.dispatchEvent(
        new CustomEvent('task-block:open-creation', {
          detail: { blockId: currentBlock.id }
        })
      )
    },
    aliases: ['task', 'todo', 'action'],
    group: 'Basic blocks',
    subtext: 'Create a linked task'
  }
}
