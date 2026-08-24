/**
 * Tests for NoteAttachmentsDialog (#1713) — the note menu's attachments panel.
 * The folder listing is the source of truth; original names come from the
 * block props via the caller's lookup.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NoteAttachmentsDialog,
  collectOriginalNames,
  lookupOriginalName
} from './note-attachments-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key)
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

const listAttachments = vi.fn()
const revealAttachmentInFinder = vi.fn().mockResolvedValue(undefined)
const openAttachmentExternal = vi.fn().mockResolvedValue(undefined)

// The global test setup owns `window.api`; tests overlay their own notes
// surface on it rather than replacing the object (same pattern as
// attachment-block-menu.test.tsx).
function setupApi(): void {
  const api = window.api as unknown as Record<string, unknown>
  api.notes = {
    ...((api.notes as Record<string, unknown>) ?? {}),
    listAttachments,
    revealAttachmentInFinder,
    openAttachmentExternal
  }
}

afterEach(() => {
  listAttachments.mockReset()
  revealAttachmentInFinder.mockClear()
  openAttachmentExternal.mockClear()
})

const ROW = {
  filename: 'abc123-report.pdf',
  path: 'memry-file://local/vault/attachments/n1/abc123-report.pdf',
  size: 2048,
  mimeType: 'application/pdf',
  type: 'file' as const
}

function renderDialog(names = new Map<string, string>()): void {
  setupApi()
  render(
    <NoteAttachmentsDialog open onOpenChange={vi.fn()} noteId="n1" getOriginalNames={() => names} />
  )
}

describe('NoteAttachmentsDialog', () => {
  it('lists the folder contents with original name, stored name and size', async () => {
    listAttachments.mockResolvedValue([ROW])
    renderDialog(new Map([['abc123-report.pdf', 'Quarterly report.pdf']]))

    const row = await screen.findByTestId('note-attachment-row')
    expect(row).toHaveTextContent('Quarterly report.pdf')
    expect(row).toHaveTextContent('editor.attachmentMenu.storedAs:abc123-report.pdf')
    expect(row).toHaveTextContent('2.0 KB')
  })

  it('falls back to the stored filename when no block names the file', async () => {
    listAttachments.mockResolvedValue([ROW])
    renderDialog()

    const row = await screen.findByTestId('note-attachment-row')
    expect(row).toHaveTextContent('abc123-report.pdf')
    expect(row).not.toHaveTextContent('storedAs')
  })

  it('reveals and opens a row through the attachment IPCs', async () => {
    listAttachments.mockResolvedValue([ROW])
    renderDialog()
    await screen.findByTestId('note-attachment-row')

    fireEvent.click(screen.getByLabelText('editor.toolbar.revealInFinder'))
    fireEvent.click(screen.getByLabelText('editor.toolbar.openInDefaultApp'))

    expect(revealAttachmentInFinder).toHaveBeenCalledWith('n1', ROW.path)
    expect(openAttachmentExternal).toHaveBeenCalledWith('n1', ROW.path)
  })

  it('shows the empty state for a note without attachments', async () => {
    listAttachments.mockResolvedValue([])
    renderDialog()

    expect(await screen.findByText('editor.attachmentsDialog.empty')).toBeInTheDocument()
  })
})

describe('lookupOriginalName', () => {
  const names = new Map([['abc123-report.pdf', 'Quarterly report.pdf']])

  it('matches the stored filename exactly', () => {
    expect(lookupOriginalName(names, 'abc123-report.pdf')).toBe('Quarterly report.pdf')
  })

  it('matches a renamed (self-healed) file by its unique 6-char prefix', () => {
    expect(lookupOriginalName(names, 'abc123-report-final.pdf')).toBe('Quarterly report.pdf')
  })

  it('returns undefined for an unknown or ambiguous prefix', () => {
    expect(lookupOriginalName(names, 'zzzzzz-other.pdf')).toBeUndefined()
    const ambiguous = new Map([
      ['abc123-a.pdf', 'A.pdf'],
      ['abc123-b.pdf', 'B.pdf']
    ])
    expect(lookupOriginalName(ambiguous, 'abc123-c.pdf')).toBeUndefined()
  })
})

describe('collectOriginalNames', () => {
  it('walks file and image blocks, including nested children', () => {
    const editor = {
      document: [
        {
          type: 'file',
          props: { url: '../attachments/n1/abc123-report.pdf', name: 'Quarterly report.pdf' },
          children: []
        },
        {
          type: 'paragraph',
          props: {},
          children: [
            {
              type: 'image',
              props: { url: '../attachments/n1/qq11ww-photo%20one.png', name: 'photo one.png' },
              children: []
            }
          ]
        }
      ]
    }

    const names = collectOriginalNames(editor)
    expect(names.get('abc123-report.pdf')).toBe('Quarterly report.pdf')
    expect(names.get('qq11ww-photo one.png')).toBe('photo one.png')
  })

  it('tolerates a missing editor or document', () => {
    expect(collectOriginalNames(null).size).toBe(0)
    expect(collectOriginalNames({}).size).toBe(0)
  })
})
