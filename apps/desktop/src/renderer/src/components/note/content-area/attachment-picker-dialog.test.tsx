/**
 * Tests for AttachmentPickerDialog (#2077, #2161).
 *
 * The dialog is the one surface every attachment command opens, so what is
 * asserted is both routes out of it: picking a stored file asks main for a
 * reference and uploads nothing, and uploading sends the bytes once. The kind
 * filter is asserted too — `/pdf` must not offer to reuse a PNG.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentPickerDialog,
  attachmentKey,
  attachmentKindMatches,
  buildInsertedAttachmentBlock,
  describeAttachmentRejection,
  filterVaultAttachments,
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES
} from './attachment-picker-dialog'
import type { AttachmentKind } from './attachment-picker-dialog'

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

// cmdk keeps the highlighted row in view; jsdom has no scroller.
Element.prototype.scrollIntoView = vi.fn()

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

function renderDialog(
  kind: AttachmentKind = 'file',
  onInsert = vi.fn()
): { onInsert: ReturnType<typeof vi.fn> } {
  setupApi()
  render(
    <AttachmentPickerDialog
      open
      onOpenChange={vi.fn()}
      noteId="note-b"
      kind={kind}
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

describe('AttachmentPickerDialog', () => {
  it('lists what the vault stores, with the note that owns each file', async () => {
    listVaultAttachments.mockResolvedValue([PDF, PHOTO])
    renderDialog()

    const rows = await screen.findAllByTestId('attachment-picker-row')
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

    fireEvent.click(await screen.findByTestId('attachment-picker-row'))

    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(result))
    expect(insertExistingAttachment).toHaveBeenCalledWith('note-b', 'note-a', PDF.filename)
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  it('narrows the list as the user types', async () => {
    listVaultAttachments.mockResolvedValue([PDF, PHOTO])
    renderDialog()
    await screen.findAllByTestId('attachment-picker-row')

    fireEvent.change(screen.getByTestId('attachment-picker-search'), {
      target: { value: 'photo' }
    })

    const rows = await screen.findAllByTestId('attachment-picker-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('photo.png')
  })

  it('reports a listing failure and shows nothing rather than a stale list', async () => {
    listVaultAttachments.mockRejectedValue(new Error('nope'))
    renderDialog()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.queryAllByTestId('attachment-picker-row')).toHaveLength(0)
  })

  it('reports an insert failure and leaves the note untouched', async () => {
    listVaultAttachments.mockResolvedValue([PDF])
    insertExistingAttachment.mockRejectedValue(new Error('gone'))
    const { onInsert } = renderDialog()

    fireEvent.click(await screen.findByTestId('attachment-picker-row'))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('shows the empty state when the vault has no attachments', async () => {
    listVaultAttachments.mockResolvedValue([])
    renderDialog()

    expect(await screen.findByTestId('attachment-picker-empty')).toHaveTextContent(
      'editor.attachmentPicker.empty.file'
    )
  })

  it('offers only the kind that was asked for, so /pdf never proposes a PNG', async () => {
    listVaultAttachments.mockResolvedValue([PDF, PHOTO])
    renderDialog('pdf')

    const rows = await screen.findAllByTestId('attachment-picker-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('report.pdf')
  })

  it('uploads a chosen file once and inserts what main stored', async () => {
    listVaultAttachments.mockResolvedValue([])
    uploadAttachment.mockResolvedValue({
      success: true,
      path: '../attachments/note-b/zzzzzz-slide.png',
      name: 'slide.png',
      size: 12,
      mimeType: 'image/png',
      type: 'image'
    })
    const { onInsert } = renderDialog('image')

    fireEvent.change(screen.getByTestId('attachment-picker-file-input'), {
      target: { files: [new File(['x'], 'slide.png', { type: 'image/png' })] }
    })

    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith({
        url: '../attachments/note-b/zzzzzz-slide.png',
        name: 'slide.png',
        size: 12,
        mimeType: 'image/png',
        type: 'image'
      })
    )
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(insertExistingAttachment).not.toHaveBeenCalled()
  })

  it('reports a failed upload and inserts nothing', async () => {
    listVaultAttachments.mockResolvedValue([])
    uploadAttachment.mockResolvedValue({ success: false, error: 'too big' })
    const { onInsert } = renderDialog('file')

    fireEvent.change(screen.getByTestId('attachment-picker-file-input'), {
      target: { files: [new File(['x'], 'huge.zip', { type: 'application/zip' })] }
    })

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('#2190: refuses an unplayable video at pick time, before any upload', async () => {
    listVaultAttachments.mockResolvedValue([])
    const { onInsert } = renderDialog('media')

    fireEvent.change(screen.getByTestId('attachment-picker-file-input'), {
      target: { files: [new File(['x'], 'holiday.avi', { type: 'video/x-msvideo' })] }
    })

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('editor.attachmentPicker.unsupportedVideo')
    )
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('#2190: accepts a playable video and uploads it once', async () => {
    listVaultAttachments.mockResolvedValue([])
    uploadAttachment.mockResolvedValue({
      success: true,
      path: '../attachments/note-b/aaaaaa-demo.mp4',
      name: 'demo.mp4',
      size: 12,
      mimeType: 'video/mp4',
      type: 'file'
    })
    const { onInsert } = renderDialog('media')

    fireEvent.change(screen.getByTestId('attachment-picker-file-input'), {
      target: { files: [new File(['x'], 'demo.mp4', { type: 'video/mp4' })] }
    })

    await waitFor(() => expect(onInsert).toHaveBeenCalled())
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
  })
})

describe('describeAttachmentRejection (#2190)', () => {
  const t = (key: string): string => key

  function fileOfSize(name: string, type: string, size: number): File {
    const file = new File(['x'], name, { type })
    // jsdom sizes a File from its parts; the cap needs a file bigger than any
    // buffer worth allocating in a test.
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  it('accepts the containers Chromium can play', () => {
    for (const name of ['clip.mp4', 'clip.webm', 'clip.MOV']) {
      expect(describeAttachmentRejection({ name, size: 10, type: 'video/mp4' }, t)).toBeNull()
    }
  })

  it('names the supported formats when the container cannot play', () => {
    expect(
      describeAttachmentRejection({ name: 'clip.mkv', size: 10, type: 'video/x-matroska' }, t)
    ).toBe('editor.attachmentPicker.unsupportedVideo')
  })

  it('rejects anything over the attachment size ceiling', () => {
    expect(
      describeAttachmentRejection(fileOfSize('big.mp4', 'video/mp4', MAX_ATTACHMENT_BYTES + 1), t)
    ).toBe('editor.attachmentPicker.tooLarge')
    expect(
      describeAttachmentRejection(fileOfSize('ok.mp4', 'video/mp4', MAX_ATTACHMENT_BYTES), t)
    ).toBeNull()
  })

  it('keeps the OS dialog filter in step with what is actually accepted', () => {
    // `video/*` here would let the user pick a file the vault then refuses.
    expect(ATTACHMENT_ACCEPT.media).toBe(
      'image/*,audio/*,video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov'
    )
  })
})

describe('attachmentKindMatches', () => {
  it('splits media from the rest of the files, which `entry.type` cannot', () => {
    expect(attachmentKindMatches('video/mp4', 'media')).toBe(true)
    expect(attachmentKindMatches('audio/mpeg', 'media')).toBe(true)
    expect(attachmentKindMatches('image/png', 'media')).toBe(true)
    expect(attachmentKindMatches('application/pdf', 'media')).toBe(false)
    expect(attachmentKindMatches('video/mp4', 'image')).toBe(false)
    expect(attachmentKindMatches('APPLICATION/PDF', 'pdf')).toBe(true)
    expect(attachmentKindMatches('application/zip', 'file')).toBe(true)
  })
})
