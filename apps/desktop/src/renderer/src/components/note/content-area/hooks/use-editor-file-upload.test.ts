import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isImageFile, useEditorFileUpload } from './use-editor-file-upload'

const mocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  getFile: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

vi.mock('@/services/notes-service', () => ({
  notesService: { uploadAttachment: mocks.uploadAttachment, getFile: mocks.getFile }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: mocks.warn,
    error: mocks.error,
    info: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../file-block', () => ({
  createFileBlockContent: (props: Record<string, unknown>) => ({ type: 'file', props })
}))

describe('isImageFile', () => {
  it('should return true for PNG files', () => {
    expect(isImageFile(new File([], 'test.png', { type: 'image/png' }))).toBe(true)
  })

  it('should return true for JPEG files', () => {
    expect(isImageFile(new File([], 'test.jpg', { type: 'image/jpeg' }))).toBe(true)
  })

  it('should return true for GIF files', () => {
    expect(isImageFile(new File([], 'test.gif', { type: 'image/gif' }))).toBe(true)
  })

  it('should return true for WebP files', () => {
    expect(isImageFile(new File([], 'test.webp', { type: 'image/webp' }))).toBe(true)
  })

  it('should return true for SVG files', () => {
    expect(isImageFile(new File([], 'test.svg', { type: 'image/svg+xml' }))).toBe(true)
  })

  it('should return false for PDF files', () => {
    expect(isImageFile(new File([], 'doc.pdf', { type: 'application/pdf' }))).toBe(false)
  })

  it('should return false for text files', () => {
    expect(isImageFile(new File([], 'readme.txt', { type: 'text/plain' }))).toBe(false)
  })

  it('should return false for Word documents', () => {
    expect(
      isImageFile(
        new File([], 'doc.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        })
      )
    ).toBe(false)
  })

  it('should handle case-insensitive MIME types', () => {
    expect(isImageFile(new File([], 'test.PNG', { type: 'IMAGE/PNG' }))).toBe(true)
  })
})

describe('useEditorFileUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.uploadAttachment.mockResolvedValue({
      success: true,
      path: '/vault/file.pdf',
      name: 'file.pdf',
      size: 512,
      mimeType: 'application/pdf'
    })
  })

  const setup = (overrides: Partial<Parameters<typeof useEditorFileUpload>[0]> = {}) => {
    const container = document.createElement('div')
    const editor = {
      getTextCursorPosition: vi.fn(() => ({ block: { id: 'cursor-block' } })),
      insertBlocks: vi.fn()
    }
    const params = {
      editor,
      noteId: 'note-1',
      editable: true,
      containerRef: { current: container },
      noteIdRef: { current: 'note-1' },
      dropTarget: null,
      onDragReset: vi.fn(),
      ...overrides
    }

    const result = renderHook(() => useEditorFileUpload(params))
    return { ...result, editor, params, container }
  }

  it('uploads via noteIdRef and reports failed uploads', async () => {
    const { result } = setup()

    await expect(result.current.uploadFile(new File(['x'], 'file.pdf'))).resolves.toBe(
      '/vault/file.pdf'
    )
    expect(mocks.uploadAttachment).toHaveBeenCalledWith('note-1', expect.any(File))

    mocks.uploadAttachment.mockResolvedValueOnce({ success: false, error: 'bad upload' })
    await expect(result.current.uploadFile(new File(['x'], 'file.pdf'))).rejects.toThrow(
      'bad upload'
    )

    const missing = setup({ noteIdRef: { current: undefined } })
    await expect(missing.result.current.uploadFile(new File(['x'], 'file.pdf'))).rejects.toThrow(
      'Cannot upload: no note selected'
    )
  })

  it('ignores image-only drops and inserts uploaded non-images', async () => {
    const { result, editor, params } = setup({
      dropTarget: { blockId: 'target-block', position: 'before' }
    })

    await expect(
      result.current.handleNonImageDrop({
        dataTransfer: { files: [new File(['x'], 'image.png', { type: 'image/png' })] },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.DragEvent)
    ).resolves.toBe(false)

    const event = {
      dataTransfer: { files: [new File(['x'], 'file.pdf', { type: 'application/pdf' })] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }

    await act(async () => {
      await result.current.handleNonImageDrop(event as unknown as React.DragEvent)
    })

    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(params.onDragReset).toHaveBeenCalled()
    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: 'file',
          props: {
            url: '/vault/file.pdf',
            name: 'file.pdf',
            size: 512,
            mimeType: 'application/pdf'
          }
        }
      ],
      'target-block',
      'before'
    )
  })

  // A rejected drop used to be silent: log + telemetry, nothing on screen.
  it('tells the user why a dropped file was rejected', async () => {
    const { result, editor } = setup()
    mocks.uploadAttachment.mockResolvedValueOnce({
      success: false,
      error: 'File too large. Maximum size is 100.0 MB, got 140.2 MB'
    })

    await act(async () => {
      await result.current.handleNonImageDrop({
        dataTransfer: { files: [new File(['x'], 'huge.pdf', { type: 'application/pdf' })] },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.DragEvent)
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      'File too large. Maximum size is 100.0 MB, got 140.2 MB'
    )
    expect(editor.insertBlocks).not.toHaveBeenCalled()
  })

  it('handles no-note and read-only drops without inserting blocks', async () => {
    const noNote = setup({ noteId: undefined })

    await noNote.result.current.handleNonImageDrop({
      dataTransfer: { files: [new File(['x'], 'file.pdf', { type: 'application/pdf' })] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as React.DragEvent)

    expect(mocks.warn).toHaveBeenCalledWith('Cannot upload attachment: no noteId provided')

    const readOnly = setup({ editable: false })
    await readOnly.result.current.handleNonImageDrop({
      dataTransfer: { files: [new File(['x'], 'file.pdf', { type: 'application/pdf' })] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as React.DragEvent)

    expect(readOnly.editor.insertBlocks).not.toHaveBeenCalled()
  })

  // A file-type item dragged out of the left sidebar carries our custom mime
  // (the note id). It is embedded by its own vault path — never re-uploaded.
  const internalDrop = (id: string) =>
    ({
      getData: (mime: string) => (mime === 'application/x-memry-note' ? id : '')
    }) as unknown as DataTransfer

  it('embeds a dropped sidebar PDF by path without copying to attachments', async () => {
    mocks.getFile.mockResolvedValue({
      absolutePath: '/vault/notes/report.pdf',
      fileType: 'pdf',
      title: 'report',
      fileSize: 1234,
      mimeType: 'application/pdf'
    })
    const { result, editor, params } = setup({
      dropTarget: { blockId: 'target-block', position: 'after' }
    })

    await act(async () => {
      await result.current.handleInternalItemDrop(internalDrop('file-id'))
    })

    expect(mocks.getFile).toHaveBeenCalledWith('file-id')
    expect(mocks.uploadAttachment).not.toHaveBeenCalled()
    expect(params.onDragReset).toHaveBeenCalled()
    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: 'file',
          props: {
            url: 'memry-file://local/vault/notes/report.pdf',
            name: 'report',
            size: 1234,
            mimeType: 'application/pdf'
          }
        }
      ],
      'target-block',
      'after'
    )
  })

  it('embeds a dropped sidebar image as an image block at the cursor', async () => {
    mocks.getFile.mockResolvedValue({
      absolutePath: '/vault/notes/pic.png',
      fileType: 'image',
      title: 'pic',
      fileSize: 50,
      mimeType: 'image/png'
    })
    const { result, editor } = setup()

    await act(async () => {
      await result.current.handleInternalItemDrop(internalDrop('img-id'))
    })

    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: 'image',
          props: {
            url: 'memry-file://local/vault/notes/pic.png',
            caption: 'pic',
            previewWidth: 600
          }
        }
      ],
      'cursor-block',
      'after'
    )
  })

  it('ignores an internal drop without the item mime and read-only drops', async () => {
    const { result, editor } = setup()
    await result.current.handleInternalItemDrop({ getData: () => '' } as unknown as DataTransfer)
    expect(mocks.getFile).not.toHaveBeenCalled()
    expect(editor.insertBlocks).not.toHaveBeenCalled()

    mocks.getFile.mockResolvedValue({
      absolutePath: '/vault/notes/report.pdf',
      fileType: 'pdf',
      title: 'report',
      fileSize: 1,
      mimeType: 'application/pdf'
    })
    const readOnly = setup({ editable: false })
    await act(async () => {
      await readOnly.result.current.handleInternalItemDrop(internalDrop('file-id'))
    })
    expect(readOnly.editor.insertBlocks).not.toHaveBeenCalled()
  })
})
