import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Comment, CommentAnchorInput } from '@/services/comments-service'

const mockUploadAttachment = vi.hoisted(() => vi.fn())
const mockNavigate = vi.hoisted(() => vi.fn())

vi.mock('@/services/notes-service', () => ({
  notesService: {
    uploadAttachment: mockUploadAttachment
  }
}))

vi.mock('@/agent-chat/messages/memry-links', () => ({
  useMemryLinkNavigation: () => mockNavigate
}))

vi.mock('@/agent-chat/ref-picker', () => ({
  RefPicker: ({
    onPick
  }: {
    onPick: (attachment: {
      kind: string
      ref_id: string
      label: string
      icon: { kind: string }
    }) => void
  }) => (
    <div role="listbox" aria-label="References">
      <button
        type="button"
        role="option"
        onClick={() =>
          onPick({
            kind: 'note',
            ref_id: 'note-mention-1',
            label: 'Mention Target',
            icon: { kind: 'note' }
          })
        }
      >
        Mention Target
      </button>
    </div>
  )
}))

import { CommentCard, CommentComposer, CommentsRail } from './comments-rail'

const anchor: CommentAnchorInput = {
  selectedQuote: 'highlighted text',
  blockId: null,
  rangeStart: 10,
  rangeEnd: 26,
  prefix: 'before ',
  suffix: ' after'
}

const baseComment: Comment = {
  id: 'comment-1',
  targetType: 'note',
  targetId: 'note-1',
  selectedQuote: 'highlighted text',
  blockId: null,
  rangeStart: 10,
  rangeEnd: 26,
  prefix: 'before ',
  suffix: ' after',
  body: 'Saved comment',
  mentionRefs: [],
  attachmentRefs: [],
  status: 'open',
  clock: null,
  syncedAt: null,
  createdAt: '2026-05-22T00:00:00.000Z',
  modifiedAt: '2026-05-22T00:00:00.000Z'
}

describe('Comment rail composer', () => {
  beforeEach(() => {
    mockUploadAttachment.mockReset()
    mockNavigate.mockReset()
  })

  it('disables send while body, mentions, and attachments are empty', () => {
    render(
      <CommentComposer targetId="note-1" anchor={anchor} onSave={vi.fn()} onCancel={vi.fn()} />
    )

    expect(screen.getByRole('button', { name: 'Save comment' })).toBeDisabled()
  })

  it('opens the @ picker and saves mentionRefs with inline mention text', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer targetId="note-1" anchor={anchor} onSave={onSave} onCancel={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Mention' }))
    await userEvent.click(screen.getByRole('option', { name: 'Mention Target' }))

    const mention = await screen.findByTestId('agent-mention-note-note-mention-1')
    expect(mention).toHaveClass('bg-sky-500/10')
    expect(mention.querySelector('svg')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        '@Mention Target',
        [],
        [{ kind: 'note', refId: 'note-mention-1', label: 'Mention Target' }]
      )
    })
  })

  it('submits on Enter and keeps Shift+Enter available for a newline', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer targetId="note-1" anchor={anchor} onSave={onSave} onCancel={vi.fn()} />)

    const textbox = screen.getByRole('textbox', { name: 'Comment body' })
    await userEvent.type(textbox, 'Line one{Shift>}{Enter}{/Shift}Line two')
    fireEvent.keyDown(textbox, { key: 'Enter' })

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('Line one\nLine two', [], [])
    })
  })

  it('uploads files and renders attachment rows before saving attachmentRefs', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    mockUploadAttachment.mockResolvedValue({
      success: true,
      path: 'memry-file://attachments/sketch.png'
    })
    render(<CommentComposer targetId="note-1" anchor={anchor} onSave={onSave} onCancel={vi.fn()} />)

    const file = new File(['image'], 'sketch.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('comment-attachment-input'), {
      target: { files: [file] }
    })

    await expect(screen.findByTestId('comment-attachment-row')).resolves.toHaveTextContent(
      'sketch.png'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('', ['memry-file://attachments/sketch.png'], [])
    })
  })

  it('renders saved mentions inline and opens attachment preview from comment cards', async () => {
    render(
      <CommentCard
        comment={{
          ...baseComment,
          mentionRefs: [{ kind: 'task', refId: 'task-1', label: 'Follow up' }],
          attachmentRefs: ['https://example.test/proof.pdf']
        }}
        active={false}
        orphaned={false}
        onClick={vi.fn()}
      />
    )

    const mention = screen.getByRole('button', { name: '@Follow up' })
    expect(mention).toHaveClass('bg-emerald-500/10')
    expect(mention.querySelector('svg')).toBeTruthy()

    await userEvent.click(mention)
    expect(mockNavigate).toHaveBeenCalledWith('memry://task/task-1', 'Follow up')

    await userEvent.click(screen.getByRole('button', { name: 'proof.pdf' }))
    expect(screen.getByTestId('comment-attachment-preview-dialog')).toBeInTheDocument()
  })

  it('keeps the single-user card header to timestamp and hover actions only', () => {
    render(
      <CommentCard
        comment={baseComment}
        active={false}
        orphaned={false}
        onClick={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.queryByText('You')).not.toBeInTheDocument()
    expect(screen.getByText('Just now')).toBeInTheDocument()
    expect(screen.getByTestId('comment-card')).toHaveClass(
      'translate-x-0',
      'transition-[transform,background-color,border-color,box-shadow]',
      'duration-200',
      'hover:-translate-x-[7px]'
    )
    expect(screen.getByRole('button', { name: 'Edit comment' })).toHaveClass(
      'hover:bg-surface-active'
    )
  })

  it('edits an existing comment from the comment card', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentCard
        comment={baseComment}
        active={false}
        orphaned={false}
        onClick={vi.fn()}
        onUpdate={onUpdate}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit comment' }))
    await userEvent.clear(screen.getByRole('textbox', { name: 'Edit comment body' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit comment body' }), 'Updated')
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(baseComment, 'Updated')
    })
  })

  it('deletes an existing comment from the comment card', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentCard
        comment={baseComment}
        active={false}
        orphaned={false}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Delete comment' }))

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(baseComment)
    })
  })

  it('uses compact markers on narrow screens and opens the card under the quote', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn()
      }))
    })

    const onCommentClick = vi.fn()
    try {
      render(
        <CommentsRail
          targetId="note-1"
          comments={[baseComment]}
          commentRects={[{ id: 'comment-1', left: 12, top: 24, width: 120, height: 18 }]}
          draftAnchor={null}
          draftTop={null}
          activeCommentId={null}
          onSaveDraft={vi.fn()}
          onCancelDraft={vi.fn()}
          onCommentClick={onCommentClick}
        />
      )

      expect(screen.queryByTestId('comment-card')).not.toBeInTheDocument()
      const marker = screen.getByTestId('compact-comment-marker')
      expect(marker.querySelector('span')).toHaveClass("before:content-['+1']")

      await userEvent.click(marker)

      expect(onCommentClick).toHaveBeenCalledWith(baseComment)
      expect(screen.getByTestId('comment-card')).toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia
      })
    }
  })
})
