import type { Block, BlockNoteEditor, PartialBlock } from '@blocknote/core'
import type { EditorSchema } from './editor-schema'

type ColumnsEditor = BlockNoteEditor<
  EditorSchema['blockSchema'],
  EditorSchema['inlineContentSchema'],
  EditorSchema['styleSchema']
>
type EditorBlock = Block<
  EditorSchema['blockSchema'],
  EditorSchema['inlineContentSchema'],
  EditorSchema['styleSchema']
>
type EditorPartialBlock = PartialBlock<
  EditorSchema['blockSchema'],
  EditorSchema['inlineContentSchema'],
  EditorSchema['styleSchema']
>

/**
 * The block a new column list goes next to. A column holds blocks, not
 * column lists (the node's content is `blockContainer+`), so a cursor inside a
 * column inserts after the whole list instead of inside it.
 */
function insertionAnchor(editor: ColumnsEditor, block: EditorBlock): EditorBlock {
  let anchor = block
  for (let parent = editor.getParentBlock(block); parent; parent = editor.getParentBlock(parent)) {
    if (parent.type === 'columnList') anchor = parent
  }
  return anchor
}

function isEmptyParagraph(block: EditorBlock): boolean {
  return (
    block.type === 'paragraph' &&
    Array.isArray(block.content) &&
    block.content.length === 0 &&
    block.children.length === 0
  )
}

export function insertColumnList(editor: ColumnsEditor, count: number): void {
  const current = editor.getTextCursorPosition().block
  const anchor = insertionAnchor(editor, current)
  const columnList: EditorPartialBlock = {
    type: 'columnList',
    children: Array.from({ length: count }, () => ({
      type: 'column',
      props: { width: 1 },
      children: [{ type: 'paragraph' }]
    }))
  }

  const [inserted] =
    anchor === current && isEmptyParagraph(current)
      ? editor.replaceBlocks([current], [columnList]).insertedBlocks
      : editor.insertBlocks([columnList], anchor, 'after')

  const firstParagraph = inserted?.children[0]?.children[0]
  if (firstParagraph) editor.setTextCursorPosition(firstParagraph, 'start')
}

export function getColumnSlashMenuItems(
  editor: ColumnsEditor,
  labels: {
    group: string
    two: { title: string; subtext: string }
    three: { title: string; subtext: string }
  }
) {
  return [
    {
      key: 'two_columns',
      title: labels.two.title,
      subtext: labels.two.subtext,
      aliases: ['columns', 'column', '2 columns', 'two columns', 'side by side', 'split', 'layout'],
      group: labels.group,
      onItemClick: () => insertColumnList(editor, 2)
    },
    {
      key: 'three_columns',
      title: labels.three.title,
      subtext: labels.three.subtext,
      aliases: ['columns', 'column', '3 columns', 'three columns', 'side by side', 'layout'],
      group: labels.group,
      onItemClick: () => insertColumnList(editor, 3)
    }
  ]
}
