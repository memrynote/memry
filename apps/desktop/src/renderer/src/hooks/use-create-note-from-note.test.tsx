import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useCreateNoteFromNote } from './use-create-note-from-note'
import { notesService, type Note } from '@/services/notes-service'

const mocks = vi.hoisted(() => ({ openTab: vi.fn() }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { openPagesInNewTab: true } })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { get: vi.fn(), create: vi.fn() }
}))

const sourceNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'source-1',
  path: 'Clients/A/Project X.md',
  title: 'Project X',
  content: 'Kickoff notes that must not be copied',
  frontmatter: {},
  created: new Date('2026-01-01'),
  modified: new Date('2026-01-02'),
  tags: ['client-a', '2026'],
  aliases: [],
  wordCount: 5,
  properties: { project: ['Project X'], Status: 'Active', Priority: 'High' },
  emoji: '📁',
  ...overrides
})

const createdNote = sourceNote({
  id: 'new-1',
  path: 'Clients/A/Untitled.md',
  title: 'Untitled',
  content: '',
  properties: {}
})

describe('useCreateNoteFromNote', () => {
  const reveals: unknown[] = []
  const onReveal = (event: Event) => reveals.push((event as CustomEvent).detail)

  beforeEach(() => {
    vi.clearAllMocks()
    reveals.length = 0
    window.addEventListener('reveal-in-sidebar', onReveal)
    vi.mocked(notesService.get).mockResolvedValue(sourceNote())
    vi.mocked(notesService.create).mockResolvedValue({ success: true, note: createdNote })
  })

  afterEach(() => {
    window.removeEventListener('reveal-in-sidebar', onReveal)
  })

  it('creates an empty note in the source folder with its icon, tags and properties', async () => {
    const { result } = renderHook(() => useCreateNoteFromNote())

    await result.current('source-1')

    expect(notesService.create).toHaveBeenCalledWith({
      title: 'Untitled',
      content: '',
      folder: 'Clients/A',
      tags: ['client-a', '2026'],
      properties: { project: ['Project X'], Status: 'Active', Priority: 'High' },
      emoji: '📁'
    })
    expect(mocks.openTab).toHaveBeenCalledWith({
      type: 'note',
      title: 'Untitled',
      icon: 'file-text',
      emoji: '📁',
      path: '/notes/new-1',
      entityId: 'new-1',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
    expect(reveals).toEqual([{ path: '/notes/new-1', entityId: 'new-1', rename: true }])
    expect(toast.success).toHaveBeenCalledWith(
      'Created with 2 tags and 3 properties from Project X'
    )
  })

  it('sends no icon for an icon-less root note so a folder template can still supply one', async () => {
    vi.mocked(notesService.get).mockResolvedValue(
      sourceNote({
        path: 'Loose.md',
        title: 'Loose',
        tags: [],
        properties: { Status: 'Draft' },
        emoji: null
      })
    )
    const { result } = renderHook(() => useCreateNoteFromNote())

    await result.current('source-1')

    expect(notesService.create).toHaveBeenCalledWith({
      title: 'Untitled',
      content: '',
      folder: undefined,
      tags: [],
      properties: { Status: 'Draft' },
      emoji: undefined
    })
    expect(toast.success).toHaveBeenCalledWith('Created with no tags and 1 property from Loose')
  })

  it('shows the create failure and opens nothing', async () => {
    vi.mocked(notesService.create).mockResolvedValue({
      success: false,
      note: null,
      error: 'Disk full'
    })
    const { result } = renderHook(() => useCreateNoteFromNote())

    await result.current('source-1')

    expect(toast.error).toHaveBeenCalledWith('Disk full')
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(reveals).toEqual([])
  })

  it('reports a source note that no longer exists', async () => {
    vi.mocked(notesService.get).mockResolvedValue(null)
    const { result } = renderHook(() => useCreateNoteFromNote())

    await result.current('source-1')

    expect(toast.error).toHaveBeenCalledWith('Failed to create note')
    expect(notesService.create).not.toHaveBeenCalled()
  })
})
