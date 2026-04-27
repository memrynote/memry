import { test as base, expect } from '@playwright/test'

/**
 * Shared base fixture: captures console errors per-test into an array the
 * test can assert against. Tests call `await page.goto('/')` themselves to
 * control when errors start being captured — the fixture only wires up the
 * listeners.
 */
type Fixtures = {
  consoleErrors: string[]
}

function installTauriBrowserShim(): void {
  type NoteListItem = {
    id: string
    path: string
    title: string
    created: string
    modified: string
    tags: string[]
    wordCount: number
    snippet: string
    emoji: string | null
    localOnly: boolean
  }

  type BrowserWindow = Window & {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      transformCallback: (callback: unknown, once?: boolean) => number
    }
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void
    }
  }

  const target = window as BrowserWindow
  const settings = new Map<string, string>()
  let callbackId = 1
  let eventId = 1

  const notes: NoteListItem[] = [
    {
      id: 'note-1',
      path: 'Inbox/welcome-to-memry-tauri.md',
      title: 'Welcome to Memry (Tauri)',
      created: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      modified: new Date(Date.now() - 86_400_000).toISOString(),
      tags: [],
      wordCount: 9,
      snippet: 'This is a mock note for browser e2e visual parity.',
      emoji: null,
      localOnly: false
    },
    {
      id: 'note-2',
      path: 'Projects/project-alpha-overview.md',
      title: 'Project Alpha overview',
      created: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      modified: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      tags: ['work'],
      wordCount: 5,
      snippet: 'Mock project details.',
      emoji: null,
      localOnly: false
    },
    {
      id: 'note-3',
      path: 'Archive/archive-draft.md',
      title: 'Archive draft',
      created: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      modified: new Date(Date.now() - 29 * 86_400_000).toISOString(),
      tags: [],
      wordCount: 2,
      snippet: 'Older content.',
      emoji: null,
      localOnly: false
    }
  ]

  function noteById(id: string): NoteListItem | null {
    return notes.find((note) => note.id === id) ?? null
  }

  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {}
  }

  target.__TAURI_INTERNALS__ = {
    transformCallback: () => callbackId++,
    invoke: async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') return eventId++
      if (cmd === 'plugin:event|unlisten') return null

      switch (cmd) {
        case 'settings_get': {
          const input = args.input as { key?: string } | undefined
          return input?.key ? (settings.get(input.key) ?? null) : null
        }
        case 'settings_set': {
          const input = args.input as { key?: string; value?: string } | undefined
          if (input?.key) settings.set(input.key, input.value ?? '')
          return null
        }
        case 'settings_list':
          return Array.from(settings.entries()).map(([key, value]) => ({ key, value }))
        case 'notify_flush_done':
          return null

        case 'notes_list':
          return { notes, total: notes.length, hasMore: false }
        case 'notes_list_by_folder': {
          const folder = ((args.args as string[] | undefined)?.[0] ?? '').toLowerCase()
          const filtered = notes.filter((note) => note.path.toLowerCase().startsWith(`${folder}/`))
          return { notes: filtered, total: filtered.length, hasMore: false }
        }
        case 'notes_get': {
          const id = (args.args as string[] | undefined)?.[0] ?? ''
          const note = noteById(id)
          return note ? { ...note, content: note.snippet } : null
        }
        case 'notes_get_by_path': {
          const path = (args.args as string[] | undefined)?.[0] ?? ''
          const note = notes.find((candidate) => candidate.path === path)
          return note ? { ...note, content: note.snippet } : null
        }
        case 'notes_create': {
          const title = (args.title as string | undefined) ?? 'Untitled'
          const folder = (args.folder as string | undefined) ?? 'Inbox'
          const now = new Date().toISOString()
          const note: NoteListItem = {
            id: `note-${notes.length + 1}`,
            path: `${folder}/${title.replace(/\s+/g, '-').toLowerCase()}.md`,
            title,
            created: now,
            modified: now,
            tags: [],
            wordCount: 0,
            snippet: (args.content as string | undefined) ?? '',
            emoji: null,
            localOnly: false
          }
          notes.unshift(note)
          return { success: true, note }
        }
        case 'notes_update':
          return { success: true, note: null }
        case 'notes_delete':
          return { success: true }
        case 'notes_get_folders':
          return [
            { path: 'Inbox', icon: 'inbox' },
            { path: 'Projects', icon: 'folder' },
            { path: 'Archive', icon: 'archive' }
          ]
        case 'notes_get_positions':
        case 'notes_get_all_positions':
          return { success: true, positions: {} }
        case 'notes_get_tags':
          return []
        case 'notes_get_links':
          return { outgoing: [], incoming: [] }
        case 'notes_get_local_only_count':
          return { count: 0 }
        case 'notes_get_property_definitions':
          return []
        case 'notes_get_folder_config':
        case 'notes_get_folder_template':
        case 'notes_resolve_by_title':
        case 'notes_preview_by_title':
        case 'notes_get_file':
          return null
        case 'notes_create_folder':
        case 'notes_rename_folder':
        case 'notes_delete_folder':
        case 'notes_set_folder_config':
        case 'notes_reorder':
        case 'notes_set_local_only':
        case 'notes_create_property_definition':
        case 'notes_update_property_definition':
        case 'notes_add_property_option':
        case 'notes_add_status_option':
        case 'notes_remove_property_option':
        case 'notes_rename_property_option':
        case 'notes_update_option_color':
        case 'notes_delete_property_definition':
        case 'notes_open_external':
        case 'notes_reveal_in_finder':
          return { success: true }
        case 'notes_ensure_property_definition':
          return { key: 'status', type: 'select', options: [] }
        case 'notes_rename':
        case 'notes_move':
          return { success: true, note: null }
        case 'notes_exists':
          return false

        case 'auth_status':
          return { unlocked: true, hasPassphrase: false, biometricAvailable: false }
        case 'account_get_info':
          return null
        case 'sync_auth_refresh_token':
        case 'sync_auth_logout':
        case 'sync_setup_setup_first_device':
        case 'sync_setup_setup_new_account':
        case 'sync_setup_confirm_recovery_phrase':
        case 'sync_linking_link_via_qr':
        case 'sync_linking_approve_linking':
          return { success: true }
        case 'sync_setup_get_recovery_phrase':
          return { phrase: 'mock recovery phrase for browser e2e lane only' }
        case 'sync_devices_get_devices':
          return { devices: [] }
        case 'sync_devices_remove_device':
        case 'sync_devices_rename_device':
          return { success: true }
        case 'sync_linking_generate_linking_qr':
          return { sessionId: 'mock-session', qrPayload: 'mock-qr' }
        case 'sync_linking_get_linking_sas':
          return { sasCode: '123456' }

        case 'crypto_encrypt_item':
          return { ciphertext: [], nonce: [], keyId: 'mock-key' }
        case 'crypto_decrypt_item':
          return { plaintext: [] }
        case 'crypto_verify_signature':
          return { valid: true }
        case 'crypto_rotate_keys':
          return { success: true, rotationId: 'mock-rotation' }
        case 'crypto_get_rotation_progress':
          return { status: 'idle', rotated: 0, total: 0 }
        case 'secrets_set_provider_key':
        case 'secrets_get_provider_key_status':
          return { configured: false }
        case 'secrets_delete_provider_key':
          return null

        case 'crdt_open_doc':
        case 'crdt_apply_update':
        case 'crdt_apply_update_chunk_finish':
          return { seq: 1 }
        case 'crdt_sync_step_1':
          return { stateVector: [], diff: [] }
        case 'crdt_close_doc':
        case 'crdt_sync_step_2':
        case 'crdt_apply_update_chunk_start':
        case 'crdt_apply_update_chunk_append':
          return null
        case 'crdt_get_snapshot':
        case 'crdt_get_state_vector':
          return []
        case 'crdt_get_or_init_doc':
          return { update: [], stateVector: [] }

        default:
          throw new Error(`Browser e2e Tauri shim missing command: ${cmd}`)
      }
    }
  }
}

export const test = base.extend<Fixtures>({
  consoleErrors: [
    async ({ page }, use) => {
      await page.addInitScript(installTauriBrowserShim)
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      page.on('pageerror', (err) => {
        errors.push(`pageerror: ${err.message}`)
      })
      await use(errors)
    },
    { auto: true }
  ]
})

export { expect }
