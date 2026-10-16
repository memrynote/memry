import { fireEvent, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createMockApi } from '@tests/setup-dom'
import { useCommandDispatcher } from '@/commands'
import { registerCommands, resetCommandStoreForTests } from '@/commands/store'
import { useFolderNoteShortcutsRuntime } from './use-folder-note-shortcuts'

const mocks = vi.hoisted(() => ({
  createNewNote: vi.fn(),
  openSettings: vi.fn()
}))

vi.mock('@/hooks/use-create-new-note', () => ({
  useCreateNewNote: () => mocks.createNewNote
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
      { folder: 'Gone', binding: { key: '2', modifiers: { meta: true, alt: true } } },
      // Shares its chord with Back, a command, which must win it.
      { folder: 'Work', binding: { key: '[', modifiers: { meta: true } } }
    ]
  })
})
window.api = api as unknown as typeof window.api

const navBack = vi.fn()

describe('useFolderNoteShortcutsRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCommandStoreForTests()
    vi.mocked(window.api.notes.getFolders).mockResolvedValue([{ path: 'Work' }])
    renderHook(() => {
      useCommandDispatcher()
      useFolderNoteShortcutsRuntime()
    })
  })

  it('creates a note in the folder its chord names, even from the editor', async () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.appendChild(editor)

    await waitFor(() => {
      fireEvent.keyDown(editor, { key: '1', ctrlKey: true, altKey: true })
      expect(mocks.createNewNote).toHaveBeenCalledWith({ folder: 'Work' })
    })
    editor.remove()
  })

  it('says the folder is gone instead of recreating it, with a way to fix the shortcut', async () => {
    await waitFor(() => {
      fireEvent.keyDown(window, { key: '2', ctrlKey: true, altKey: true })
      expect(toast.error).toHaveBeenCalled()
    })
    expect(mocks.createNewNote).not.toHaveBeenCalled()
    const [message, options] = vi.mocked(toast.error).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(message).toBe('The folder "Gone" no longer exists')
    options.action.onClick()
    expect(mocks.openSettings).toHaveBeenCalledWith('shortcuts')
  })

  it('leaves a chord to the command that owns it, and creates no note', async () => {
    registerCommands('tabs', 'tabs', () => ({ 'tabs.navBack': { run: navBack } }))
    // The folder shortcuts load asynchronously; wait for a folder chord to prove they have.
    await waitFor(() => {
      fireEvent.keyDown(window, { key: '2', ctrlKey: true, altKey: true })
      expect(toast.error).toHaveBeenCalled()
    })

    const event = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)

    expect(navBack).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.createNewNote).not.toHaveBeenCalled()
  })
})
