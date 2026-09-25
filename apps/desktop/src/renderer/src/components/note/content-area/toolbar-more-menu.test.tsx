import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolbarMoreMenu } from './toolbar-more-menu'

const mocks = vi.hoisted(() => ({
  blocks: [] as Array<{ id: string; props?: Record<string, unknown> }>,
  editor: {
    isEditable: true,
    getSelection: vi.fn(() => ({ blocks: mocks.blocks })),
    getTextCursorPosition: vi.fn(() => ({ block: mocks.blocks[0] })),
    canNestBlock: vi.fn(() => true),
    canUnnestBlock: vi.fn(() => false),
    nestBlock: vi.fn(),
    unnestBlock: vi.fn(),
    focus: vi.fn(),
    transact: vi.fn((fn: () => void) => fn()),
    updateBlock: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/icons', () => {
  const Icon = () => <span />
  return {
    MoreHorizontal: Icon,
    Pin: Icon,
    TextAlignCenter: Icon,
    TextAlignLeft: Icon,
    TextAlignRight: Icon,
    TextIndentLess: Icon,
    TextIndentMore: Icon
  }
})

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => mocks.editor,
  useEditorState: ({ selector }: { selector: (payload: { editor: unknown }) => unknown }) =>
    selector({ editor: mocks.editor }),
  useDictionary: () => ({
    formatting_toolbar: {
      align_left: { tooltip: 'Align left' },
      align_center: { tooltip: 'Align center' },
      align_right: { tooltip: 'Align right' },
      nest: { tooltip: 'Nest block' },
      unnest: { tooltip: 'Unnest block' }
    }
  }),
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({ label }: { label: string }) => <button type="button" aria-label={label} />
    },
    Generic: {
      Menu: {
        Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
        Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
        Dropdown: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
        Divider: () => <hr />,
        Item: ({
          children,
          checked,
          onClick
        }: {
          children: ReactNode
          checked?: boolean
          onClick?: () => void
        }) => (
          <button type="button" role="menuitem" aria-checked={checked} onClick={onClick}>
            {children}
          </button>
        )
      }
    }
  })
}))

describe('ToolbarMoreMenu', () => {
  beforeEach(() => {
    mocks.blocks = [
      { id: 'a', props: { textAlignment: 'center' } },
      { id: 'b', props: { textAlignment: 'left' } }
    ]
    mocks.editor.updateBlock.mockClear()
    mocks.editor.nestBlock.mockClear()
    mocks.editor.unnestBlock.mockClear()
  })

  it('aligns every selected block and marks the current alignment', () => {
    render(<ToolbarMoreMenu isPinned={false} />)

    expect(screen.getByText('Align center')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByText('Align right'))
    expect(mocks.editor.updateBlock).toHaveBeenCalledTimes(2)
    expect(mocks.editor.updateBlock).toHaveBeenCalledWith('b', {
      props: { textAlignment: 'right' }
    })
  })

  // Blocks like images carry no textAlignment prop; offering
  // alignment for them would silently do nothing.
  it('hides alignment when no selected block can be aligned', () => {
    mocks.blocks = [{ id: 'img', props: { url: 'x' } }]

    render(<ToolbarMoreMenu isPinned={false} />)

    expect(screen.queryByText('Align left')).not.toBeInTheDocument()
  })

  it('only nests or unnests when the editor allows it', () => {
    render(<ToolbarMoreMenu isPinned={false} />)

    fireEvent.click(screen.getByText('Nest block'))
    fireEvent.click(screen.getByText('Unnest block'))

    expect(mocks.editor.nestBlock).toHaveBeenCalledTimes(1)
    expect(mocks.editor.unnestBlock).not.toHaveBeenCalled()
  })

  it('toggles the pin setting, and hides it without a host handler', () => {
    const onPinnedChange = vi.fn()
    const { rerender } = render(<ToolbarMoreMenu isPinned onPinnedChange={onPinnedChange} />)

    const pin = screen.getByText('editor.toolbar.pinToTop')
    expect(pin).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(pin)
    expect(onPinnedChange).toHaveBeenCalledWith(false)

    rerender(<ToolbarMoreMenu isPinned />)
    expect(screen.queryByText('editor.toolbar.pinToTop')).not.toBeInTheDocument()
  })
})
