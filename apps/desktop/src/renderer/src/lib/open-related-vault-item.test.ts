import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMetadata, Note } from '@memry/rpc/notes'

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn() }
}))

vi.mock('sonner', () => ({ toast }))
vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))
vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: vi.fn(),
    getFile: vi.fn()
  }
}))

import { notesService } from '@/services/notes-service'
import { openRelatedVaultItem } from './open-related-vault-item'

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 'note-1',
    title: 'Q3 planning',
    emoji: null,
    ...overrides
  }) as Note

const file = (overrides: Partial<FileMetadata> = {}): FileMetadata =>
  ({
    id: 'file-1',
    title: 'Contract.pdf',
    fileType: 'pdf',
    ...overrides
  }) as FileMetadata

describe('openRelatedVaultItem', () => {
  const getNote = vi.mocked(notesService.get)
  const getFile = vi.mocked(notesService.getFile)
  const openTab = vi.fn()

  beforeEach(() => {
    getNote.mockReset()
    getFile.mockReset()
    openTab.mockReset()
    toast.error.mockClear()
  })

  it('opens a note tab for an id the vault still holds', async () => {
    getFile.mockResolvedValue(null)
    getNote.mockResolvedValue(note({ emoji: '📝' }))

    await openRelatedVaultItem('note-1', openTab)

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Q3 planning',
        emoji: '📝',
        path: '/notes/note-1',
        entityId: 'note-1'
      })
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens a file tab when the id is a filed binary', async () => {
    getFile.mockResolvedValue(file())

    await openRelatedVaultItem('file-1', openTab)

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', path: '/file/file-1' })
    )
    expect(getNote).not.toHaveBeenCalled()
  })

  // A task linked to an id nothing resolves used to open a blank "Untitled"
  // note tab, which reads as the note having lost its content (#2271).
  it('reports an unresolvable id instead of opening a blank note', async () => {
    getFile.mockResolvedValue(null)
    getNote.mockResolvedValue(null)

    await openRelatedVaultItem('note-gone', openTab)

    expect(openTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('drawer.relatedItemMissing')
  })

  // Tasks created in a journal day before #2271 was fixed carry `j<date>`,
  // which resolves to no note whenever the vault cached that file under a
  // scanner-assigned id. The day is still there, so open it by date.
  it('opens the journal day for a j<date> id the cache does not hold', async () => {
    getFile.mockResolvedValue(null)
    getNote.mockResolvedValue(null)

    await openRelatedVaultItem('j2026-01-05', openTab)

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'journal',
        path: '/journal',
        viewState: { date: '2026-01-05' }
      })
    )
    expect(toast.error).not.toHaveBeenCalled()
  })
})
