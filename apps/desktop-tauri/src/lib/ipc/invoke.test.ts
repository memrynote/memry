import { describe, it, expect, vi, beforeEach } from 'vitest'

// Global setup in tests/setup-dom.ts auto-mocks '@/lib/ipc/invoke' for
// downstream consumers (services, hooks, components). This file tests the
// actual invoke module, so we unmock both module ids it may be registered
// under before wiring up its own collaborators.
vi.unmock('@/lib/ipc/invoke')
vi.unmock('./invoke')

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => ({ tauri: true, cmd, args }))
}))

vi.mock('./mocks', () => ({
  mockRouter: vi.fn(async (cmd: string, args: unknown) => {
    if (cmd === 'unknown_command') {
      throw new Error(`Mock IPC: command "${cmd}" not implemented`)
    }
    return { mock: true, cmd, args }
  })
}))

import { invoke } from './invoke'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { mockRouter } from './mocks'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('invoke', () => {
  it('routes commands without a real backend to mock router by default', async () => {
    const result = await invoke('notes_get_folders')
    expect(mockRouter).toHaveBeenCalledWith('notes_get_folders', undefined)
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ mock: true, cmd: 'notes_get_folders', args: undefined })
  })

  it('routes shipped notes CRUD commands to Tauri by default', async () => {
    await invoke('notes_create', { title: 'test' })
    await invoke('notes_get', { args: ['note-1'] })
    await invoke('notes_get_by_path', { args: ['Inbox/test.md'] })
    await invoke('notes_update', { id: 'note-1', title: 'Renamed' })
    await invoke('notes_delete', { args: ['note-1'] })
    await invoke('notes_list', { limit: 10 })
    await invoke('notes_list_by_folder', { args: ['Inbox'] })

    expect(mockRouter).not.toHaveBeenCalled()
    expect(tauriInvoke).toHaveBeenCalledTimes(7)
  })

  it('propagates descriptive error when mock router has no handler', async () => {
    await expect(invoke('unknown_command')).rejects.toThrow(
      /Mock IPC: command "unknown_command" not implemented/
    )
  })

  it('bypasses mock router and routes to Tauri when VITE_MOCK_IPC=false', async () => {
    vi.stubEnv('VITE_MOCK_IPC', 'false')
    const result = await invoke('some_cmd', { x: 1 })
    expect(tauriInvoke).toHaveBeenCalledWith('some_cmd', { x: 1 })
    expect(mockRouter).not.toHaveBeenCalled()
    expect(result).toEqual({ tauri: true, cmd: 'some_cmd', args: { x: 1 } })
  })

  it('passes empty args object to Tauri when args omitted', async () => {
    vi.stubEnv('VITE_MOCK_IPC', 'false')
    await invoke('some_cmd')
    expect(tauriInvoke).toHaveBeenCalledWith('some_cmd', {})
  })

  it('passes args through untouched to mock router (no default empty object)', async () => {
    await invoke('notes_get_tags')
    expect(mockRouter).toHaveBeenCalledWith('notes_get_tags', undefined)
  })
})
