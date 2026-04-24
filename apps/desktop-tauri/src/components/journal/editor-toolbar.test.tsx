/**
 * Editor Toolbar tests (Phase 5.3 — journal editor polish).
 *
 * Covers the previously-stubbed image upload and focus-mode toggle,
 * plus the guards that keep them disabled when callers forget to
 * thread `journalId` / `onFocusToggle` through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Editor } from '@tiptap/react'

import { EditorToolbar } from './editor-toolbar'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    uploadAttachment: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback
}))

type ChainMock = {
  focus: () => ChainMock
  setImage: ReturnType<typeof vi.fn>
  setLink: ReturnType<typeof vi.fn>
  toggleBold: ReturnType<typeof vi.fn>
  toggleItalic: ReturnType<typeof vi.fn>
  toggleUnderline: ReturnType<typeof vi.fn>
  toggleStrike: ReturnType<typeof vi.fn>
  toggleHeading: ReturnType<typeof vi.fn>
  toggleBulletList: ReturnType<typeof vi.fn>
  toggleOrderedList: ReturnType<typeof vi.fn>
  toggleTaskList: ReturnType<typeof vi.fn>
  toggleBlockquote: ReturnType<typeof vi.fn>
  setHorizontalRule: ReturnType<typeof vi.fn>
  toggleCodeBlock: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

function makeEditor(): { editor: Editor; chain: ChainMock } {
  const chain: ChainMock = {
    focus: () => chain,
    setImage: vi.fn().mockReturnThis(),
    setLink: vi.fn().mockReturnThis(),
    toggleBold: vi.fn().mockReturnThis(),
    toggleItalic: vi.fn().mockReturnThis(),
    toggleUnderline: vi.fn().mockReturnThis(),
    toggleStrike: vi.fn().mockReturnThis(),
    toggleHeading: vi.fn().mockReturnThis(),
    toggleBulletList: vi.fn().mockReturnThis(),
    toggleOrderedList: vi.fn().mockReturnThis(),
    toggleTaskList: vi.fn().mockReturnThis(),
    toggleBlockquote: vi.fn().mockReturnThis(),
    setHorizontalRule: vi.fn().mockReturnThis(),
    toggleCodeBlock: vi.fn().mockReturnThis(),
    run: vi.fn()
  }

  const editor = {
    chain: () => chain,
    isActive: vi.fn(() => false)
  } as unknown as Editor

  return { editor, chain }
}

describe('EditorToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  describe('image upload', () => {
    it('disables the Image button when no journalId is provided', () => {
      // #given
      const { editor } = makeEditor()

      // #when
      render(<EditorToolbar editor={editor} />)

      // #then
      expect(screen.getByRole('button', { name: 'Image' })).toBeDisabled()
    })

    it('uploads and inserts the image when journalId is provided', async () => {
      // #given
      const { editor, chain } = makeEditor()
      const { notesService } = await import('@/services/notes-service')
      vi.mocked(notesService.uploadAttachment).mockResolvedValue({
        success: true,
        path: '/vault/attachments/foo.png',
        name: 'foo.png'
      })

      render(<EditorToolbar editor={editor} journalId="2026-04-16" />)

      const fileInput = screen.getByTestId('journal-image-input') as HTMLInputElement
      const file = new File(['hello'], 'foo.png', { type: 'image/png' })

      // #when
      fireEvent.change(fileInput, { target: { files: [file] } })
      await vi.waitFor(() => expect(chain.setImage).toHaveBeenCalled())

      // #then
      expect(notesService.uploadAttachment).toHaveBeenCalledWith('2026-04-16', file)
      expect(chain.setImage).toHaveBeenCalledWith({
        src: '/vault/attachments/foo.png',
        alt: 'foo.png'
      })
      expect(chain.run).toHaveBeenCalled()
    })

    it('shows an error toast when upload fails', async () => {
      // #given
      const { editor, chain } = makeEditor()
      const { notesService } = await import('@/services/notes-service')
      const { toast } = await import('sonner')
      vi.mocked(notesService.uploadAttachment).mockResolvedValue({
        success: false,
        error: 'Quota exceeded'
      })

      render(<EditorToolbar editor={editor} journalId="2026-04-16" />)

      const fileInput = screen.getByTestId('journal-image-input') as HTMLInputElement
      const file = new File(['data'], 'bar.png', { type: 'image/png' })

      // #when
      fireEvent.change(fileInput, { target: { files: [file] } })
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())

      // #then
      expect(chain.setImage).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('Quota exceeded')
    })
  })

  describe('focus mode', () => {
    it('disables the focus button when onFocusToggle is not provided', () => {
      // #given
      const { editor } = makeEditor()

      // #when
      render(<EditorToolbar editor={editor} />)

      // #then
      expect(screen.getByRole('button', { name: 'Focus Mode' })).toBeDisabled()
    })

    it('fires onFocusToggle when the focus button is clicked', () => {
      // #given
      const { editor } = makeEditor()
      const onFocusToggle = vi.fn()

      render(<EditorToolbar editor={editor} onFocusToggle={onFocusToggle} />)

      // #when
      fireEvent.click(screen.getByRole('button', { name: 'Focus Mode' }))

      // #then
      expect(onFocusToggle).toHaveBeenCalledTimes(1)
    })

    it('flips the icon label and aria-pressed state when isFocusMode is true', () => {
      // #given
      const { editor } = makeEditor()

      // #when
      render(<EditorToolbar editor={editor} isFocusMode onFocusToggle={() => {}} />)

      // #then
      const button = screen.getByRole('button', { name: 'Exit Focus Mode' })
      expect(button).toHaveAttribute('aria-pressed', 'true')
    })
  })
})
