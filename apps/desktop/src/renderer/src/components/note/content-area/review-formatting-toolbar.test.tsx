import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewFormattingToolbar } from './review-formatting-toolbar'

const toolbarMocks = vi.hoisted(() => {
  const selectedBlock = {
    id: 'block-1',
    type: 'paragraph',
    props: {},
    content: []
  }

  const Icon = () => <span data-testid="block-type-icon" />

  return {
    selectedBlock,
    blockTypeItems: [
      { name: 'Normal text', type: 'paragraph', icon: Icon },
      { name: 'Heading 1', type: 'heading', props: { level: 1 }, icon: Icon }
    ],
    editor: {
      dictionary: {},
      isEditable: true,
      prosemirrorState: {
        selection: { empty: false, from: 1, to: 5 },
        doc: { textBetween: vi.fn(() => 'selected text') }
      },
      getSelection: vi.fn(() => ({ blocks: [selectedBlock] })),
      getTextCursorPosition: vi.fn(() => ({ block: selectedBlock })),
      focus: vi.fn(),
      transact: vi.fn((callback: () => void) => callback()),
      updateBlock: vi.fn()
    }
  }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      if (key === 'comments.toolbarComment') return 'Comment'
      if (key === 'comments.toolbarSuggest') return 'Suggest edit'
      return key
    }
  })
}))

vi.mock('@/lib/icons', () => ({
  ChevronDown: () => <span data-testid="chevron-down-icon" />,
  MessageCircle: ({ size }: { size?: number }) => (
    <span data-testid="comment-icon" data-size={size} />
  ),
  PenLine: ({ size }: { size?: number }) => <span data-testid="suggest-icon" data-size={size} />
}))

vi.mock('@blocknote/react', () => ({
  FormattingToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="formatting-toolbar">{children}</div>
  ),
  FormattingToolbarController: ({
    formattingToolbar
  }: {
    formattingToolbar: (props: Record<string, unknown>) => React.ReactNode
  }) => <>{formattingToolbar({ blockTypeSelectItems: toolbarMocks.blockTypeItems })}</>,
  BasicTextStyleButton: ({ basicTextStyle }: { basicTextStyle: string }) => (
    <button type="button" data-testid={`style-${basicTextStyle}`}>
      {basicTextStyle}
    </button>
  ),
  TextAlignButton: ({ textAlignment }: { textAlignment: string }) => (
    <button type="button" data-testid={`align-${textAlignment}`}>
      {textAlignment}
    </button>
  ),
  ColorStyleButton: () => (
    <button type="button" data-testid="colors">
      colors
    </button>
  ),
  NestBlockButton: () => (
    <button type="button" data-testid="nest">
      nest
    </button>
  ),
  UnnestBlockButton: () => (
    <button type="button" data-testid="unnest">
      unnest
    </button>
  ),
  CreateLinkButton: () => (
    <button type="button" data-testid="create-link">
      link
    </button>
  ),
  blockTypeSelectItems: () => toolbarMocks.blockTypeItems,
  getFormattingToolbarItems: () => [<button key="default">default toolbar</button>],
  useBlockNoteEditor: () => toolbarMocks.editor,
  useComponentsContext: () => ({
    FormattingToolbar: {
      Button: ({
        label,
        icon,
        onClick,
        onPointerDown,
        onMouseDown,
        isDisabled,
        className,
        children,
        ...props
      }: {
        label: string
        icon?: React.ReactNode
        onClick?: () => void
        onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
        onMouseDown?: React.MouseEventHandler<HTMLButtonElement>
        isDisabled?: boolean
        className?: string
        children?: React.ReactNode
      }) => (
        <button
          type="button"
          className={className}
          data-test={props['data-test' as keyof typeof props] as string}
          disabled={isDisabled}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
        >
          {icon}
          {children ?? label}
        </button>
      )
    },
    Generic: {
      Menu: {
        Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
        Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
        Button: ({
          children,
          className,
          label
        }: {
          children?: React.ReactNode
          className?: string
          label: string
        }) => (
          <button type="button" className={className} aria-label={label}>
            {children ?? label}
          </button>
        ),
        Dropdown: ({ children, className }: { children: React.ReactNode; className?: string }) => (
          <div className={className}>{children}</div>
        ),
        Item: ({
          children,
          icon,
          onClick
        }: {
          children: React.ReactNode
          icon?: React.ReactNode
          onClick?: () => void
        }) => (
          <button type="button" onClick={onClick}>
            {icon}
            {children}
          </button>
        )
      }
    }
  }),
  useEditorState: ({ selector }: { selector: (payload: { editor: unknown }) => unknown }) =>
    selector({ editor: toolbarMocks.editor })
}))

describe('ReviewFormattingToolbar', () => {
  beforeEach(() => {
    toolbarMocks.editor.prosemirrorState.selection.empty = false
    toolbarMocks.editor.updateBlock.mockClear()
    toolbarMocks.editor.focus.mockClear()
    toolbarMocks.editor.transact.mockClear()
  })

  it('renders the compact floating grid with visible review actions', () => {
    render(
      <ReviewFormattingToolbar
        blockTypeSelectItems={toolbarMocks.blockTypeItems as any}
        onAddComment={vi.fn()}
        onStartSuggestionMode={vi.fn()}
      />
    )

    expect(screen.getByTestId('style-bold')).toBeInTheDocument()
    expect(screen.getByTestId('style-italic')).toBeInTheDocument()
    expect(screen.getByTestId('style-underline')).toBeInTheDocument()
    expect(screen.getByTestId('style-strike')).toBeInTheDocument()
    expect(screen.getByTestId('align-left')).toBeInTheDocument()
    expect(screen.getByTestId('align-center')).toBeInTheDocument()
    expect(screen.getByTestId('align-right')).toBeInTheDocument()
    expect(screen.getByTestId('colors')).toBeInTheDocument()
    expect(screen.getByTestId('nest')).toBeInTheDocument()
    expect(screen.getByTestId('unnest')).toBeInTheDocument()
    expect(screen.getByTestId('create-link')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Normal text' })[0]).toHaveClass(
      'review-block-type-trigger'
    )
    expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument()
    expect(screen.getByText('Comment')).toBeInTheDocument()
    expect(screen.getByTestId('comment-icon')).toHaveAttribute('data-size', '16')
    expect(screen.getByText('Suggest edit')).toBeInTheDocument()
    expect(screen.getByTestId('suggest-icon')).toHaveAttribute('data-size', '16')
  })

  it('disables Comment when the editor selection is empty', () => {
    toolbarMocks.editor.prosemirrorState.selection.empty = true

    render(
      <ReviewFormattingToolbar
        blockTypeSelectItems={toolbarMocks.blockTypeItems as any}
        onAddComment={vi.fn()}
      />
    )

    expect(screen.getByText('Comment')).toBeDisabled()
  })

  it('starts suggestion mode from the visible action row', () => {
    const onStartSuggestionMode = vi.fn()

    render(
      <ReviewFormattingToolbar
        blockTypeSelectItems={toolbarMocks.blockTypeItems as any}
        onStartSuggestionMode={onStartSuggestionMode}
      />
    )

    fireEvent.click(screen.getByText('Suggest edit'))

    expect(onStartSuggestionMode).toHaveBeenCalledTimes(1)
  })

  it('captures the selected range before the toolbar click can collapse it', () => {
    const onAddComment = vi.fn()

    render(
      <ReviewFormattingToolbar
        blockTypeSelectItems={toolbarMocks.blockTypeItems as any}
        onAddComment={onAddComment}
      />
    )

    fireEvent.pointerDown(screen.getByText('Comment'))

    expect(onAddComment).toHaveBeenCalledWith({
      text: 'selected text',
      isEmpty: false,
      from: 1,
      to: 5
    })
  })

  it('applies block type conversion from the block type menu', () => {
    render(<ReviewFormattingToolbar blockTypeSelectItems={toolbarMocks.blockTypeItems as any} />)

    fireEvent.click(screen.getByText('Heading 1'))

    expect(toolbarMocks.editor.focus).toHaveBeenCalledTimes(1)
    expect(toolbarMocks.editor.transact).toHaveBeenCalledTimes(1)
    expect(toolbarMocks.editor.updateBlock).toHaveBeenCalledWith(toolbarMocks.selectedBlock, {
      type: 'heading',
      props: { level: 1 }
    })
  })
})
