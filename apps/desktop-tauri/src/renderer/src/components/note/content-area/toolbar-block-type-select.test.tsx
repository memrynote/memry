import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolbarBlockTypeSelect } from './toolbar-block-type-select'

const mocks = vi.hoisted(() => {
  const paragraph = (id: string) => ({ id, type: 'paragraph', props: {} })
  const state = {
    selection: [paragraph('a'), paragraph('b'), paragraph('c')] as Array<{
      id: string
      type: string
      props: Record<string, unknown>
    }>
  }
  return {
    state,
    paragraph,
    editor: {
      isEditable: true,
      dictionary: {},
      getSelection: vi.fn(() =>
        state.selection.length > 1 ? { blocks: state.selection } : undefined
      ),
      getTextCursorPosition: vi.fn(() => ({ block: state.selection[state.selection.length - 1] })),
      focus: vi.fn(),
      transact: vi.fn((fn: () => void) => fn()),
      updateBlock: vi.fn()
    }
  }
})

vi.mock('@blocknote/core', () => ({ editorHasBlockWithType: () => true }))

vi.mock('@blocknote/react', () => ({
  blockTypeSelectItems: () => [
    { name: 'Paragraph', type: 'paragraph', icon: () => null },
    { name: 'Heading 1', type: 'heading', props: { level: 1 }, icon: () => null }
  ],
  useBlockNoteEditor: () => mocks.editor,
  useEditorState: ({ selector }: { selector: (p: { editor: unknown }) => unknown }) =>
    selector({ editor: mocks.editor }),
  useComponentsContext: () => ({
    FormattingToolbar: {
      Select: ({
        items
      }: {
        items: Array<{ text: string; onClick: () => void; icon: ReactNode }>
      }) => (
        <div>
          <button type="button">trigger</button>
          {items.map((item) => (
            <button key={item.text} type="button" onClick={item.onClick}>
              {item.text}
            </button>
          ))}
        </div>
      )
    }
  })
}))

describe('ToolbarBlockTypeSelect', () => {
  beforeEach(() => {
    mocks.state.selection = ['a', 'b', 'c'].map(mocks.paragraph)
    mocks.editor.updateBlock.mockClear()
  })

  // Opening the dropdown moves focus out of the editor and the selection
  // collapses to the cursor on the last line. The retype must still cover
  // every block that was selected when the trigger was pressed.
  it('retypes the blocks selected at pointer-down, not the collapsed cursor', () => {
    const { rerender } = render(<ToolbarBlockTypeSelect />)

    fireEvent.pointerDown(screen.getByText('trigger'))
    mocks.state.selection = [mocks.paragraph('c')]
    rerender(<ToolbarBlockTypeSelect />)
    fireEvent.click(screen.getByText('Heading 1'))

    expect(mocks.editor.updateBlock.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(mocks.editor.updateBlock).toHaveBeenCalledWith('a', {
      type: 'heading',
      props: { level: 1 }
    })
  })

  it('falls back to the live selection without a captured one', () => {
    render(<ToolbarBlockTypeSelect />)

    fireEvent.click(screen.getByText('Heading 1'))

    expect(mocks.editor.updateBlock).toHaveBeenCalledTimes(3)
  })
})
