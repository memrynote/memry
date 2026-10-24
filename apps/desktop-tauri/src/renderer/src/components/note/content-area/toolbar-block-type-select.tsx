import { editorHasBlockWithType } from '@blocknote/core'
import {
  blockTypeSelectItems,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  type BlockTypeSelectItem
} from '@blocknote/react'
import { useMemo } from 'react'
import { getBlockSelection, getMarqueeSelectedBlocks } from './marquee-block-registry'

type SelectedBlock = { id: string; type: string; props: Record<string, unknown> }
type PropType = 'string' | 'number' | 'boolean'

type SelectionEditor = {
  getBlock: (id: string) => SelectedBlock | undefined
  getSelection: () => { blocks: SelectedBlock[] } | undefined
  getTextCursorPosition: () => { block: SelectedBlock }
}

/**
 * Blocks selected when the user last pressed the block type trigger.
 *
 * BlockNote's stock `BlockTypeSelect` reads the selection at render time. Opening
 * the dropdown moves focus out of the editor and the selection collapses to the
 * cursor, so the re-rendered item handler retyped only the last line of a
 * multi-line selection. Capturing on pointer-down, before focus moves, keeps the
 * selection the user actually made. Keyed by editor, not held in component
 * state: BlockNote remounts the toolbar mid-interaction.
 */
const pendingSelection = new WeakMap<object, SelectedBlock[]>()

export function ToolbarBlockTypeSelect({ items }: { items?: BlockTypeSelectItem[] }) {
  const Components = useComponentsContext()
  const editor = useBlockNoteEditor()
  const selectedBlocks = useEditorState({
    editor,
    selector: ({ editor: stateEditor }) => getSelectedBlocks(stateEditor)
  })
  const first = selectedBlocks[0]

  const selectItems = useMemo(() => {
    const available = (items ?? blockTypeSelectItems(editor.dictionary)).filter((item) =>
      editorHasBlockWithType(
        editor,
        item.type,
        Object.fromEntries(
          Object.entries(item.props ?? {}).map(([name, value]): [string, PropType] => [
            name,
            typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean'
          ])
        )
      )
    )
    return available.map((item) => {
      const Icon = item.icon
      const isSelected =
        item.type === first?.type &&
        Object.entries(item.props ?? {}).every(([name, value]) => first.props[name] === value)
      return {
        text: item.name,
        icon: <Icon size={16} />,
        isSelected,
        onClick: () => {
          const targets = pendingSelection.get(editor) ?? getSelectedBlocks(editor)
          pendingSelection.delete(editor)
          editor.focus()
          editor.transact(() => {
            for (const block of targets) {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the picker item's type/props are runtime strings; BlockNote's updateBlock only accepts the editor's compile-time schema literals
              editor.updateBlock(block.id, { type: item.type, props: item.props } as never)
            }
          })
          getBlockSelection(editor)?.clear()
        }
      }
    })
  }, [editor, items, first])

  if (!Components || !editor.isEditable) return null
  if (!selectItems.some((item) => item.isSelected)) return null

  return (
    <span
      className="memry-format-toolbar-block-type-trigger"
      onPointerDownCapture={() => pendingSelection.set(editor, getSelectedBlocks(editor))}
      onKeyDownCapture={() => pendingSelection.set(editor, getSelectedBlocks(editor))}
    >
      <Components.FormattingToolbar.Select className="bn-select" items={selectItems} />
    </span>
  )
}

/** Marquee block selection first: it leaves the editor's caret on the last line. */
function getSelectedBlocks(editor: SelectionEditor): SelectedBlock[] {
  return (
    getMarqueeSelectedBlocks(editor) ??
    editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]
  )
}
