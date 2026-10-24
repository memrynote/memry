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

type ColumnLabel = { title: string; subtext: string }

const COLUMN_ITEMS = [
  { key: 'two_columns', count: 2, label: 'two', aliases: ['2 columns', 'two columns', 'split'] },
  { key: 'three_columns', count: 3, label: 'three', aliases: ['3 columns', 'three columns'] },
  { key: 'four_columns', count: 4, label: 'four', aliases: ['4 columns', 'four columns'] },
  { key: 'five_columns', count: 5, label: 'five', aliases: ['5 columns', 'five columns'] }
] as const

export function getColumnSlashMenuItems(
  editor: ColumnsEditor,
  labels: {
    group: string
    two: ColumnLabel
    three: ColumnLabel
    four: ColumnLabel
    five: ColumnLabel
  }
) {
  return COLUMN_ITEMS.map(({ key, count, label, aliases }) => ({
    key,
    title: labels[label].title,
    subtext: labels[label].subtext,
    aliases: ['columns', 'column', ...aliases, 'side by side', 'layout'],
    group: labels.group,
    onItemClick: () => insertColumnList(editor, count)
  }))
}
