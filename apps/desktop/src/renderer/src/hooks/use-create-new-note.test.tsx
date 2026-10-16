import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { beginVaultSwitch, resetVaultSwitchState } from '@/lib/vault-switch-state'
import { isNewNoteTitlePending } from '@/lib/new-note-title'
import { useCreateNewNote } from './use-create-new-note'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  openPage: vi.fn(),
  openTab: vi.fn(),
  selectedFolder: '',
  settings: { createInSelectedFolder: true }
}))

vi.mock('@/services/notes-service', () => ({ notesService: { create: mocks.create } }))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
vi.mock('@/hooks/use-open-target', () => ({ useOpenPage: () => ({ openPage: mocks.openPage }) }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: mocks.settings })
}))
vi.mock('@/contexts/selected-folder-context', () => ({
  useSelectedFolder: () => ({ selectedFolder: mocks.selectedFolder })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

/** Where the sidebar was told to look, in order. */
function recordReveals(): string[] {
  const revealed: string[] = []
  window.addEventListener('reveal-in-sidebar', (event) => {
    revealed.push((event as CustomEvent<{ entityId: string }>).detail.entityId)
  })
  return revealed
}

describe('useCreateNewNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetVaultSwitchState()
    mocks.selectedFolder = ''
    mocks.settings = { createInSelectedFolder: true }
    mocks.create.mockResolvedValue({ success: true, note: { id: 'note-1', title: 'New note' } })
  })

  it('creates the note in the selected folder, opens it with its title ready for typing, and reveals it', async () => {
    mocks.selectedFolder = 'Projects/Alpha'
    const revealed = recordReveals()
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current())

    expect(mocks.create).toHaveBeenCalledWith({
      title: 'New note',
      content: '',
      folder: 'Projects/Alpha'
    })
    expect(isNewNoteTitlePending('note-1')).toBe(true)
    expect(mocks.openPage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', path: '/note/note-1', entityId: 'note-1' })
    )
    expect(revealed).toContain('note-1')
  })

  it('opens a genuinely new tab in the named pane for the tab bar "+" menu, whatever the preference', async () => {
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current({ inNewTabOf: { groupId: 'group-2' } }))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1' }),
      { groupId: 'group-2' }
    )
    expect(mocks.openPage).not.toHaveBeenCalled()
  })

  it('leaves the folder to main when nothing is selected', async () => {
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current())

    expect(mocks.create).toHaveBeenCalledWith({
      title: 'New note',
      content: '',
      folder: undefined
    })
  })

  it('ignores the selection when "create in selected folder" is off', async () => {
    mocks.selectedFolder = 'Projects'
    mocks.settings = { createInSelectedFolder: false }
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current())

    expect(mocks.create).toHaveBeenCalledWith({
      title: 'New note',
      content: '',
      folder: undefined
    })
  })

  it('creates in the folder it is told, whatever the selection or the setting', async () => {
    mocks.selectedFolder = 'Projects'
    mocks.settings = { createInSelectedFolder: false }
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current({ folder: 'Work/Meetings' }))

    expect(mocks.create).toHaveBeenCalledWith({
      title: 'New note',
      content: '',
      folder: 'Work/Meetings'
    })
  })

  it('tells the user and opens nothing when creating fails', async () => {
    mocks.create.mockRejectedValue(new Error('disk full'))
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current())

    expect(toast.error).toHaveBeenCalledWith('disk full')
    expect(mocks.openPage).not.toHaveBeenCalled()
  })

  it('creates nothing while a vault switch is in flight', async () => {
    beginVaultSwitch({ path: '/b', name: 'B' }, null)
    const { result } = renderHook(() => useCreateNewNote())

    await act(() => result.current())

    expect(mocks.create).not.toHaveBeenCalled()
  })
})
