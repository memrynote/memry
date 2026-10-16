import { fireEvent, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createMockApi } from '@tests/setup-dom'
import { useFolderNoteShortcutsRuntime } from './use-folder-note-shortcuts'

const mocks = vi.hoisted(() => ({
  createNoteInFolder: vi.fn(),
  openSettings: vi.fn()
}))

vi.mock('@/hooks/use-create-note-in-folder', () => ({
  useCreateNoteInFolder: () => mocks.createNoteInFolder
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteMutations: () => ({ createNote: { mutateAsync: vi.fn() } })
}))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const api = createMockApi()
Object.assign(api.settings, {
  getKeyboardSettings: vi.fn().mockResolvedValue({
    overrides: {},
    globalCapture: null,
    folderNoteShortcuts: [
      { folder: 'Work', binding: { key: '1', modifiers: { meta: true, alt: true } } },
      { folder: 'Gone', binding: { key: '2', modifiers: { meta: true, alt: true } } }
    ]
  })
})
window.api = api as unknown as typeof window.api

describe('useFolderNoteShortcutsRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.notes.getFolders).mockResolvedValue([{ path: 'Work' }])
  })

  it('creates a note in the folder its chord names, even from the editor', async () => {
    renderHook(() => useFolderNoteShortcutsRuntime())
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.appendChild(editor)

    await waitFor(() => {
      fireEvent.keyDown(editor, { key: '1', ctrlKey: true, altKey: true })
      expect(mocks.createNoteInFolder).toHaveBeenCalledWith('Work')
    })
    editor.remove()
  })

  it('says the folder is gone instead of recreating it, with a way to fix the shortcut', async () => {
    renderHook(() => useFolderNoteShortcutsRuntime())

    await waitFor(() => {
      fireEvent.keyDown(window, { key: '2', ctrlKey: true, altKey: true })
      expect(toast.error).toHaveBeenCalled()
    })
    expect(mocks.createNoteInFolder).not.toHaveBeenCalled()
    const [message, options] = vi.mocked(toast.error).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(message).toBe('The folder "Gone" no longer exists')
    options.action.onClick()
    expect(mocks.openSettings).toHaveBeenCalledWith('shortcuts')
  })
})
