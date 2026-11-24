import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteFilesDownloadNotice } from './note-files-download-notice'

const downloadNoteFiles = vi.mocked(window.api.syncAttachments.downloadNoteFiles)

describe('NoteFilesDownloadNotice', () => {
  beforeEach(() => {
    downloadNoteFiles.mockReset()
  })

  it('asks main for the note files and shows nothing when they arrive', async () => {
    downloadNoteFiles.mockResolvedValue({ success: true })

    const { container } = render(<NoteFilesDownloadNotice noteId="note-1" />)

    await vi.waitFor(() => expect(downloadNoteFiles).toHaveBeenCalledWith({ noteId: 'note-1' }))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the failure and downloads again on Try again', async () => {
    downloadNoteFiles.mockResolvedValueOnce({ success: false, error: 'R2 unavailable' })
    let finish: (result: { success: boolean }) => void = () => undefined
    downloadNoteFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    render(<NoteFilesDownloadNotice noteId="note-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't download this note's files: R2 unavailable"
    )
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByRole('status')).toHaveTextContent("Downloading this note's files…")
    expect(screen.queryByRole('alert')).toBeNull()
    expect(downloadNoteFiles).toHaveBeenCalledTimes(2)

    finish({ success: true })
    await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('offers no Try again for a file the server no longer has', async () => {
    downloadNoteFiles.mockResolvedValue({
      success: false,
      error: 'This file is no longer on the sync server.',
      canRetry: false
    })

    render(<NoteFilesDownloadNotice noteId="note-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't download this note's files: This file is no longer on the sync server."
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
