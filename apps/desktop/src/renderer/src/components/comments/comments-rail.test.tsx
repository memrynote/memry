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

import { CommentCard, CommentComposer } from './comments-rail'

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

  it('opens the @ picker and saves mentionRefs separately from the body', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer targetId="note-1" anchor={anchor} onSave={onSave} onCancel={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Mention' }))
    await userEvent.click(screen.getByRole('option', { name: 'Mention Target' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        '',
        [],
        [{ kind: 'note', refId: 'note-mention-1', label: 'Mention Target' }]
      )
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

  it('renders saved mentions and opens attachment preview from comment cards', async () => {
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

    await userEvent.click(screen.getByRole('button', { name: 'Follow up' }))
    expect(mockNavigate).toHaveBeenCalledWith('memry://task/task-1', 'Follow up')

    await userEvent.click(screen.getByRole('button', { name: 'proof.pdf' }))
    expect(screen.getByTestId('comment-attachment-preview-dialog')).toBeInTheDocument()
  })
})
