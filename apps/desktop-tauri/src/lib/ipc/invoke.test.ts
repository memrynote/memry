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
    const result = await invoke('notes_export_pdf')
    expect(mockRouter).toHaveBeenCalledWith('notes_export_pdf', undefined)
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ mock: true, cmd: 'notes_export_pdf', args: undefined })
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
    await invoke('notes_export_pdf')
    expect(mockRouter).toHaveBeenCalledWith('notes_export_pdf', undefined)
  })

  it('routes Phase E rename/move/exists/local-only/tags/links commands to Tauri', async () => {
    await invoke('notes_rename', { args: ['note-1', 'New Title'] })
    await invoke('notes_move', { args: ['note-1', 'Archive'] })
    await invoke('notes_exists', { args: ['Inbox/foo.md'] })
    await invoke('notes_set_local_only', { args: ['note-1', true] })
    await invoke('notes_get_local_only_count')
    await invoke('notes_get_tags')
    await invoke('notes_get_links', { args: ['note-1'] })
    await invoke('notes_resolve_by_title', { args: ['Title'] })
    await invoke('notes_preview_by_title', { args: ['Title'] })

    expect(mockRouter).not.toHaveBeenCalled()
    expect(tauriInvoke).toHaveBeenCalledTimes(9)
  })

  it('routes graduated folder/property/position commands to Tauri by default', async () => {
    const commands = [
      'notes_get_folders',
      'notes_create_folder',
      'notes_rename_folder',
      'notes_delete_folder',
      'notes_get_folder_config',
      'notes_set_folder_config',
      'notes_get_folder_template',
      'notes_get_positions',
      'notes_get_all_positions',
      'notes_reorder',
      'notes_get_property_definitions',
      'notes_create_property_definition',
      'notes_update_property_definition',
      'notes_ensure_property_definition',
      'notes_add_property_option',
      'notes_add_status_option',
      'notes_remove_property_option',
      'notes_rename_property_option',
      'notes_update_option_color',
      'notes_delete_property_definition'
    ]

    for (const command of commands) {
      await invoke(command, { input: {} })
    }

    expect(mockRouter).not.toHaveBeenCalled()
    expect(tauriInvoke).toHaveBeenCalledTimes(commands.length)
  })
})
