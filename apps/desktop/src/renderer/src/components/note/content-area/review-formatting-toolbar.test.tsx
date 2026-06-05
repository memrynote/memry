import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewFormattingToolbar } from './review-formatting-toolbar'

const toolbarMocks = vi.hoisted(() => ({
  editor: {
    prosemirrorState: {
      selection: { empty: false, from: 2, to: 15 },
      doc: { textBetween: vi.fn(() => 'selected text') }
    }
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      if (key === 'comments.toolbarComment') return 'Comment'
      if (key === 'comments.toolbarSuggest') return 'Suggest'
      return key
    }
  })
}))

vi.mock('@/lib/icons', () => ({
  MessageCircle: () => <span data-testid="comment-icon" />,
  PenLine: () => <span data-testid="suggest-icon" />
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
    toolbarMocks.editor.prosemirrorState.doc.textBetween.mockClear()
  })

  it('adds Comment and Suggest to the selected text toolbar', () => {
    render(<ReviewFormattingToolbar onAddComment={vi.fn()} onStartSuggestionMode={vi.fn()} />)

    expect(screen.getByText('bold')).toBeInTheDocument()
    expect(screen.getByText('Comment')).toBeInTheDocument()
    expect(screen.getByText('Suggest')).toBeInTheDocument()
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

  it('starts page-level suggestion mode and disables Comment without selection', () => {
    const onStartSuggestionMode = vi.fn()
    toolbarMocks.editor.prosemirrorState.selection.empty = true

    render(
      <ReviewFormattingToolbar
        onAddComment={vi.fn()}
        onStartSuggestionMode={onStartSuggestionMode}
      />
    )

    expect(screen.getByText('Comment')).toBeDisabled()
    fireEvent.click(screen.getByText('Suggest'))
    expect(onStartSuggestionMode).toHaveBeenCalledTimes(1)
  })
})
