import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isImageFile, useEditorFileUpload } from './use-editor-file-upload'

const mocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { uploadAttachment: mocks.uploadAttachment }
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
})
