import { parseMarkdownPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

interface TaskBlockLike {
  id: string
  type: string
  props?: Record<string, unknown>
  children?: unknown[]
}

interface CheckboxEditor {
  getBlock: (id: string) => TaskBlockLike | undefined
  updateBlock: (block: TaskBlockLike, update: Record<string, unknown>) => unknown
}

/**
 * A task block becomes a plain checkbox holding the task's line.
 *
 * The title is the line's markdown (links, bold, wiki links), so it is parsed
 * back through the note's own pipeline rather than pasted in as one text run.
 * A task with subtasks under it is refused: its children would be task blocks
 * under a checkbox, which no rule in the editor files anywhere.
 */
export async function turnTaskIntoCheckbox(editor: CheckboxEditor, blockId: string): Promise<void> {
  const block = editor.getBlock(blockId)
  if (!block || block.type !== 'taskBlock' || block.children?.length) return

  const title = typeof block.props?.title === 'string' ? block.props.title : ''
  const checked = block.props?.checked === true
  const line = `- [${checked ? 'x' : ' '}] ${title}`
  const parsed = await parseMarkdownPreservingBlanks(editor, line)
  const [checkbox] = normalizeNoteBlocks(parsed, line)
  const content =
    checkbox?.type === 'checkListItem'
      ? checkbox.content
      : [{ type: 'text', text: title, styles: {} }]

  // Re-read after the parse: the block may have changed under the await.
  const live = editor.getBlock(blockId)
  if (!live || live.type !== 'taskBlock') return
  editor.updateBlock(live, { type: 'checkListItem', props: { checked, plain: true }, content })
}
