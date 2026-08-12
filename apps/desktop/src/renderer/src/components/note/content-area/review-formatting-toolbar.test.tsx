import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewFormattingToolbar } from './review-formatting-toolbar'

const toolbarMocks = vi.hoisted(() => ({
  editor: {
    prosemirrorState: {
      selection: { empty: false, from: 2, to: 15 },
      doc: { textBetween: vi.fn(() => 'selected text') }
    },
    schema: {
      blockSchema: {
        paragraph: { content: 'inline' },
        bulletListItem: { content: 'inline' },
        numberedListItem: { content: 'inline' },
        checkListItem: { content: 'inline' }
      }
    },
    selectedBlocks: [
      { id: 'b1', type: 'paragraph' },
      { id: 'b2', type: 'paragraph' }
    ] as Array<{ id: string; type: string }>,
    getSelection: vi.fn(() => ({ blocks: toolbarMocks.editor.selectedBlocks })),
    getTextCursorPosition: vi.fn(() => ({ block: toolbarMocks.editor.selectedBlocks[0] })),
    focus: vi.fn(),
    transact: vi.fn((fn: () => void) => fn()),
    updateBlock: vi.fn()
  }
}))

const listLabels: Record<string, string> = {
  'editor.list.bulleted': 'Bulleted list',
  'editor.list.numbered': 'Numbered list',
  'editor.list.checklist': 'Check list'
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      if (key === 'comments.toolbarComment') return 'Comment'
      return listLabels[key] ?? key
    }
  })
}))

vi.mock('@/lib/icons', () => ({
  MessageCircle: () => <span data-testid="comment-icon" />,
  List: () => <span data-testid="bulleted-icon" />,
  ListOrdered: () => <span data-testid="numbered-icon" />,
  ListChecks: () => <span data-testid="checklist-icon" />
}))

vi.mock('@blocknote/react', () => ({
  FormattingToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="formatting-toolbar">{children}</div>
  ),
  FormattingToolbarController: ({
    formattingToolbar
  }: {
    formattingToolbar: (props: Record<string, unknown>) => React.ReactNode
  }) => <>{formattingToolbar({})}</>,
  BlockTypeSelect: () => <button type="button">block type</button>,
  BasicTextStyleButton: ({ basicTextStyle }: { basicTextStyle: string }) => (
    <button type="button">{basicTextStyle}</button>
  ),
  TextAlignButton: ({ textAlignment }: { textAlignment: string }) => (
    <button type="button">{textAlignment}</button>
  ),
  ColorStyleButton: () => <button type="button">color</button>,
  NestBlockButton: () => <button type="button">nest</button>,
  UnnestBlockButton: () => <button type="button">unnest</button>,
  CreateLinkButton: () => <button type="button">link</button>,
  getFormattingToolbarItems: () => [<button key="default">default</button>],
  useBlockNoteEditor: () => toolbarMocks.editor,
  useEditorState: ({ selector }: { selector: (payload: { editor: unknown }) => unknown }) =>
    selector({ editor: toolbarMocks.editor }),
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({
        label,
        icon,
        onClick,
        isDisabled,
        ...props
      }: {
        label: string
        icon?: React.ReactNode
        onClick?: () => void
        isDisabled?: boolean
      }) => (
        <button
          type="button"
          data-test={props['data-test' as keyof typeof props] as string}
          disabled={isDisabled}
          onClick={onClick}
        >
          {icon}
          {label}
        </button>
      )
    }
  })
}))

describe('ReviewFormattingToolbar', () => {
  beforeEach(() => {
    toolbarMocks.editor.prosemirrorState.selection.empty = false
    ;(toolbarMocks.editor.prosemirrorState.selection as { node?: unknown }).node = undefined
    toolbarMocks.editor.prosemirrorState.doc.textBetween.mockClear()
    toolbarMocks.editor.selectedBlocks = [
      { id: 'b1', type: 'paragraph' },
      { id: 'b2', type: 'paragraph' }
    ]
    toolbarMocks.editor.updateBlock.mockClear()
    ;(toolbarMocks.editor as { _tiptapEditor?: unknown })._tiptapEditor = undefined
  })

  it('adds Comment to the selected text toolbar', () => {
    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    expect(screen.getByText('bold')).toBeInTheDocument()
    expect(screen.getByText('Comment')).toBeInTheDocument()
  })

  // The floating toolbar is what every note gets by default (note.tsx always
  // passes `review`, so BlockNote's stock toolbar never renders). Block type
  // controls used to appear only in the sticky variant, which meant turning
  // "Sticky Formatting Toolbar" off silently removed the only way to switch a
  // block to a heading/list from the selection popup.
  it('offers block type controls in the floating toolbar', () => {
    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    expect(screen.getByText('block type')).toBeInTheDocument()
  })

  // Issue #1206: the block type dropdown could already retype a whole
  // selection, but it is labelled with the current type ("Paragraph"), so
  // nobody hunting for bullets opened it. The toggles make that transform
  // visible in both toolbar variants.
  it('offers bulleted, numbered and check list toggles in the floating toolbar', () => {
    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    expect(screen.getByText('Bulleted list')).toBeInTheDocument()
    expect(screen.getByText('Numbered list')).toBeInTheDocument()
    expect(screen.getByText('Check list')).toBeInTheDocument()
  })

  it('offers the list toggles in the sticky toolbar too', () => {
    render(<ReviewFormattingToolbar variant="sticky" onAddComment={vi.fn()} />)

    expect(screen.getByText('Bulleted list')).toBeInTheDocument()
    expect(screen.getByText('Numbered list')).toBeInTheDocument()
    expect(screen.getByText('Check list')).toBeInTheDocument()
  })

  it('converts every selected block, not just the first', () => {
    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    fireEvent.click(screen.getByText('Bulleted list'))

    expect(toolbarMocks.editor.updateBlock).toHaveBeenCalledTimes(2)
    expect(toolbarMocks.editor.updateBlock).toHaveBeenNthCalledWith(
      1,
      { id: 'b1', type: 'paragraph' },
      { type: 'bulletListItem' }
    )
    expect(toolbarMocks.editor.updateBlock).toHaveBeenNthCalledWith(
      2,
      { id: 'b2', type: 'paragraph' },
      { type: 'bulletListItem' }
    )
  })

  it('toggles a fully bulleted selection back to paragraphs', () => {
    toolbarMocks.editor.selectedBlocks = [
      { id: 'b1', type: 'bulletListItem' },
      { id: 'b2', type: 'bulletListItem' }
    ]

    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)
    fireEvent.click(screen.getByText('Bulleted list'))

    expect(toolbarMocks.editor.updateBlock).toHaveBeenNthCalledWith(1, expect.anything(), {
      type: 'paragraph'
    })
  })

  it('leaves blocks without inline content out of the conversion', () => {
    toolbarMocks.editor.selectedBlocks = [
      { id: 'b1', type: 'paragraph' },
      { id: 'task', type: 'taskBlock' }
    ]

    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)
    fireEvent.click(screen.getByText('Bulleted list'))

    expect(toolbarMocks.editor.updateBlock).toHaveBeenCalledTimes(1)
    expect(toolbarMocks.editor.updateBlock).toHaveBeenCalledWith(
      { id: 'b1', type: 'paragraph' },
      { type: 'bulletListItem' }
    )
  })

  it('captures selected text before clicking Comment collapses selection', () => {
    const onAddComment = vi.fn()

    const { rerender } = render(<ReviewFormattingToolbar onAddComment={onAddComment} />)

    toolbarMocks.editor.prosemirrorState.selection.empty = true
    rerender(<ReviewFormattingToolbar onAddComment={onAddComment} />)
    expect(screen.getByText('Comment')).toBeEnabled()

    fireEvent.click(screen.getByText('Comment'))
    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'selected text',
        isEmpty: false,
        from: 2,
        to: 15
      })
    )
  })

  it('uses cached selected text when click-time selection has no readable text', () => {
    const onAddComment = vi.fn()

    const { rerender } = render(<ReviewFormattingToolbar onAddComment={onAddComment} />)

    toolbarMocks.editor.prosemirrorState.doc.textBetween.mockReturnValue('')
    rerender(<ReviewFormattingToolbar onAddComment={onAddComment} />)
    expect(screen.getByText('Comment')).toBeEnabled()

    fireEvent.click(screen.getByText('Comment'))
    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'selected text',
        isEmpty: false,
        from: 2,
        to: 15
      })
    )
  })

  it('suppresses the floating toolbar for a block (node) selection', () => {
    ;(toolbarMocks.editor.prosemirrorState.selection as { node?: unknown }).node = {
      type: 'bookmark'
    }

    const { container } = render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    expect(screen.queryByText('Comment')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('disables Comment without a selection', () => {
    toolbarMocks.editor.prosemirrorState.selection.empty = true

    render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)

    expect(screen.getByText('Comment')).toBeDisabled()
  })

  // Regression for #541: TipTap 3.x `editor.view` returns a Proxy that throws
  // on any property access (e.g. `.dom`) until the ProseMirror view is mounted.
  // The toolbar reads `view.dom` while reading the selection; before the guard,
  // that threw "[tiptap error]: ... Cannot access view['dom']" and crashed the
  // editor into its error boundary ("Editor Error") on note open.
  it('does not crash when the ProseMirror view is not mounted yet', () => {
    const unmountedView = new Proxy(
      {},
      {
        get(_target, key) {
          throw new Error(
            `[tiptap error]: The editor view is not available. Cannot access view['${String(key)}']. The editor may not be mounted yet.`
          )
        }
      }
    )
    ;(toolbarMocks.editor as { _tiptapEditor?: unknown })._tiptapEditor = {
      state: { selection: { empty: true } },
      view: unmountedView,
      // editorView is the real mounted view — absent until the PM view mounts.
      editorView: undefined
    }

    vi.useFakeTimers()
    try {
      expect(() => {
        render(<ReviewFormattingToolbar onAddComment={vi.fn()} />)
        // Flush the deferred selection read in ReviewToolbarButton's effect,
        // which also routes through `view.dom`.
        vi.runOnlyPendingTimers()
      }).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
