import { mapTableCell, type BlockNoteEditor, type TableContent } from '@blocknote/core'
import { TableHandlesExtension } from '@blocknote/core/extensions'
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState
} from '@blocknote/react'
import {
  MoreHorizontal,
  Pin,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextIndentLess,
  TextIndentMore
} from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

type TextAlignment = 'left' | 'center' | 'right'

const ALIGNMENTS: Array<{
  value: TextAlignment
  icon: typeof TextAlignLeft
  dictKey: 'align_left' | 'align_center' | 'align_right'
}> = [
  { value: 'left', icon: TextAlignLeft, dictKey: 'align_left' },
  { value: 'center', icon: TextAlignCenter, dictKey: 'align_center' },
  { value: 'right', icon: TextAlignRight, dictKey: 'align_right' }
]

interface ToolbarMoreMenuProps {
  /** Whether the toolbar is currently pinned to the top of the note. */
  isPinned: boolean
  /** Omitted where the host has no toolbar setting to write (the item hides). */
  onPinnedChange?: (pinned: boolean) => void
}

/**
 * Overflow for the formatting toolbar: actions people reach for rarely enough
 * that a permanent button costs more row width than it saves clicks.
 *
 * Built on BlockNote's own generic menu rather than the app dropdown so it
 * inherits the focus handling BlockNote's toolbar menus rely on — a menu that
 * portals elsewhere blurs the editor and the floating toolbar closes under it.
 */
export function ToolbarMoreMenu({ isPinned, onPinnedChange }: ToolbarMoreMenuProps) {
  const { t } = useT('notes')
  const Components = useComponentsContext()
  const dict = useDictionary()
  const editor = useBlockNoteEditor()
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      const blocks = getSelectedBlocks(editor as BlockNoteEditor)
      const alignable = blocks.filter((block) => 'textAlignment' in (block.props ?? {}))
      const first = alignable[0]?.props as { textAlignment?: TextAlignment } | undefined
      const cells = selectedTableCells(editor as BlockNoteEditor, blocks)
      return {
        canAlign: alignable.length > 0 || cells !== null,
        alignment: first?.textAlignment ?? cells?.alignment ?? 'left',
        canNest: editor.isEditable && (editor as BlockNoteEditor).canNestBlock(),
        canUnnest: editor.isEditable && (editor as BlockNoteEditor).canUnnestBlock()
      }
    }
  })

  if (!Components) return null

  const label = t('editor.toolbar.more')

  const setAlignment = (textAlignment: TextAlignment): void => {
    editor.focus()
    const blocks = getSelectedBlocks(editor)
    const cells = selectedTableCells(editor, blocks)
    if (cells) {
      alignTableCells(editor, cells, textAlignment)
      return
    }
    editor.transact(() => {
      for (const block of blocks) {
        if (!('textAlignment' in (block.props ?? {}))) continue
        editor.updateBlock(block.id, { props: { textAlignment } } as never)
      }
    })
  }

  return (
    <Components.Generic.Menu.Root position="bottom-end">
      <Components.Generic.Menu.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="toolbar-more"
          label={label}
          mainTooltip={label}
          icon={<MoreHorizontal size={16} />}
        />
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown memry-toolbar-menu">
        {state.canAlign &&
          ALIGNMENTS.map(({ value, icon: Icon, dictKey }) => (
            <Components.Generic.Menu.Item
              key={value}
              icon={<Icon size={15} />}
              checked={state.alignment === value}
              onClick={() => setAlignment(value)}
            >
              {dict.formatting_toolbar[dictKey].tooltip}
            </Components.Generic.Menu.Item>
          ))}
        {state.canAlign && <Components.Generic.Menu.Divider />}
        <Components.Generic.Menu.Item
          icon={<TextIndentMore size={15} />}
          onClick={() => {
            if (!state.canNest) return
            editor.focus()
            editor.nestBlock()
          }}
        >
          {dict.formatting_toolbar.nest.tooltip}
        </Components.Generic.Menu.Item>
        <Components.Generic.Menu.Item
          icon={<TextIndentLess size={15} />}
          onClick={() => {
            if (!state.canUnnest) return
            editor.focus()
            editor.unnestBlock()
          }}
        >
          {dict.formatting_toolbar.unnest.tooltip}
        </Components.Generic.Menu.Item>
        {onPinnedChange && <Components.Generic.Menu.Divider />}
        {onPinnedChange && (
          <Components.Generic.Menu.Item
            icon={<Pin size={15} />}
            checked={isPinned}
            onClick={() => onPinnedChange(!isPinned)}
          >
            {t('editor.toolbar.pinToTop')}
          </Components.Generic.Menu.Item>
        )}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  )
}

type AnyBlock = { id: string; type?: string; props?: Record<string, unknown>; content?: unknown }

interface SelectedTableCells {
  block: AnyBlock
  positions: Array<{ row: number; col: number }>
  alignment: TextAlignment
}

/**
 * The cells selected inside a table, or null outside one. A table keeps
 * alignment per cell, not on the block, so the block-props path cannot see it.
 */
function selectedTableCells(
  editor: BlockNoteEditor,
  blocks: AnyBlock[]
): SelectedTableCells | null {
  const block = blocks[0]
  if (blocks.length !== 1 || block?.type !== 'table') return null
  const selection = editor.getExtension(TableHandlesExtension)?.getCellSelection()
  if (!selection || selection.cells.length === 0) return null
  const { row, col } = selection.cells[0]
  const rows = (block.content as TableContent<never, never>).rows
  const alignment = mapTableCell(rows[row].cells[col]).props.textAlignment
  return {
    block,
    positions: selection.cells,
    alignment: alignment === 'justify' ? 'left' : alignment
  }
}

function alignTableCells(
  editor: BlockNoteEditor,
  { block, positions }: SelectedTableCells,
  textAlignment: TextAlignment
): void {
  const content = block.content as TableContent<never, never>
  const rows = content.rows.map((row) => ({
    ...row,
    cells: row.cells.map((cell) => mapTableCell(cell))
  }))
  for (const { row, col } of positions) {
    rows[row].cells[col].props.textAlignment = textAlignment
  }
  editor.updateBlock(block.id, { type: 'table', content: { ...content, rows } } as never)
  // updateBlock moves the selection out of the table; put the cursor back.
  editor.setTextCursorPosition(block.id)
}

function getSelectedBlocks(editor: BlockNoteEditor): AnyBlock[] {
  return (editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]) as AnyBlock[]
}
