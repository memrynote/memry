/**
 * Tests for InsertExistingAttachmentDialog (#2077).
 *
 * The dialog's whole job is to turn a picked row into block props that point at
 * bytes already in the vault, so what is asserted is that it asks main for the
 * reference and never uploads anything.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InsertExistingAttachmentDialog,
  attachmentKey,
  buildInsertedAttachmentBlock,
  filterVaultAttachments
} from './insert-existing-attachment-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const listVaultAttachments = vi.fn()
const insertExistingAttachment = vi.fn()
const uploadAttachment = vi.fn()

function setupApi(): void {
  const api = window.api as unknown as Record<string, unknown>
  api.notes = {
    ...((api.notes as Record<string, unknown>) ?? {}),
    listVaultAttachments,
    insertExistingAttachment,
    uploadAttachment
  }
}

afterEach(() => {
  toastError.mockReset()
  listVaultAttachments.mockReset()
  insertExistingAttachment.mockReset()
  uploadAttachment.mockReset()
})

const PDF = {
  ownerNoteId: 'note-a',
  ownerNoteTitle: 'Invoices',
  filename: 'k3f9x2-report.pdf',
  displayName: 'report.pdf',
  size: 2048,
  mimeType: 'application/pdf',
  type: 'file' as const,
  modifiedAt: '2026-09-10T00:00:00.000Z'
}

const PHOTO = {
  ...PDF,
  ownerNoteId: 'note-c',
  ownerNoteTitle: 'Trip',
  filename: 'aaaaaa-photo.png',
  displayName: 'photo.png',
  mimeType: 'image/png',
  type: 'image' as const
}

function renderDialog(onInsert = vi.fn()): { onInsert: ReturnType<typeof vi.fn> } {
  setupApi()
  render(
    <InsertExistingAttachmentDialog
      open
      onOpenChange={vi.fn()}
      noteId="note-b"
      onInsert={onInsert}
    />
  )
  return { onInsert }
}

describe('filterVaultAttachments', () => {
  it('matches the file name and the owning note title, case-insensitively', () => {
    expect(filterVaultAttachments([PDF, PHOTO], 'REPORT')).toEqual([PDF])
    expect(filterVaultAttachments([PDF, PHOTO], 'trip')).toEqual([PHOTO])
    expect(filterVaultAttachments([PDF, PHOTO], '  ')).toEqual([PDF, PHOTO])
  })
})

describe('buildInsertedAttachmentBlock', () => {
  it('builds an image block for an image, keeping the name as the caption', () => {
    expect(
      buildInsertedAttachmentBlock({
        url: '../attachments/note-c/aaaaaa-photo.png',
        name: 'photo.png',
        size: 10,
        mimeType: 'image/png',
        type: 'image'
      })
    ).toEqual({
      type: 'image',
      props: {
        url: '../attachments/note-c/aaaaaa-photo.png',
        caption: 'photo.png',
        previewWidth: 600
      }
    })
  })

  it('builds a file block for everything else, carrying size and mime type', () => {
    expect(
      buildInsertedAttachmentBlock({
        url: '../attachments/note-a/k3f9x2-report.pdf',
        name: 'report.pdf',
        size: 2048,
        mimeType: 'application/pdf',
        type: 'file'
      })
    ).toEqual({
      type: 'file',
      props: {
        url: '../attachments/note-a/k3f9x2-report.pdf',
        name: 'report.pdf',
        size: 2048,
        mimeType: 'application/pdf'
      }
    })
  })
})

describe('attachmentKey', () => {
  it('keeps two same-named files in different folders distinct', () => {
    expect(attachmentKey({ ownerNoteId: 'a', filename: 'x.pdf' })).not.toBe(
      attachmentKey({ ownerNoteId: 'b', filename: 'x.pdf' })
    )
  })
})

describe('InsertExistingAttachmentDialog', () => {
  it('lists what the vault stores, with the note that owns each file', async () => {
    listVaultAttachments.mockResolvedValue([PDF, PHOTO])
    renderDialog()

    const rows = await screen.findAllByTestId('insert-existing-attachment-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('report.pdf')
    expect(rows[0]).toHaveTextContent('Invoices')
  })

  it('inserts a reference to the picked file without uploading anything', async () => {
    listVaultAttachments.mockResolvedValue([PDF])
    const result = {
      url: '../attachments/note-a/k3f9x2-report.pdf',
      name: 'report.pdf',
      filename: PDF.filename,
      ownerNoteId: 'note-a',
      size: 2048,
      mimeType: 'application/pdf',
      type: 'file' as const
    }
    insertExistingAttachment.mockResolvedValue(result)
    const { onInsert } = renderDialog()

    fireEvent.click(await screen.findByTestId('insert-existing-attachment-row'))

    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(result))
    expect(insertExistingAttachment).toHaveBeenCalledWith('note-b', 'note-a', PDF.filename)
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  it('narrows the list as the user types', async () => {
    listVaultAttachments.mockResolvedValue([PDF, PHOTO])
    renderDialog()
    await screen.findAllByTestId('insert-existing-attachment-row')

    fireEvent.change(screen.getByTestId('insert-existing-attachment-search'), {
      target: { value: 'photo' }
    })

    const rows = await screen.findAllByTestId('insert-existing-attachment-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('photo.png')
  })

  it('reports a listing failure and shows nothing rather than a stale list', async () => {
    listVaultAttachments.mockRejectedValue(new Error('nope'))
    renderDialog()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.queryAllByTestId('insert-existing-attachment-row')).toHaveLength(0)
  })

  it('reports an insert failure and leaves the note untouched', async () => {
    listVaultAttachments.mockResolvedValue([PDF])
    insertExistingAttachment.mockRejectedValue(new Error('gone'))
    const { onInsert } = renderDialog()

    fireEvent.click(await screen.findByTestId('insert-existing-attachment-row'))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('shows the empty state when the vault has no attachments', async () => {
    listVaultAttachments.mockResolvedValue([])
    renderDialog()

    expect(await screen.findByText('editor.insertExistingAttachment.empty')).toBeInTheDocument()
  })
})
