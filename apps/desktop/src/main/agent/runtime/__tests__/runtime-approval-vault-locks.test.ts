import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn(),
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({ setWriteGate: mocks.setWriteGate }))
vi.mock('../event-bus', () => ({ broadcastAgentEvent: mocks.broadcastAgentEvent }))
vi.mock('electron', () => ({
  // App settings fall back to their defaults: no settings file lives here.
  app: { getPath: () => '/nonexistent-memry-test-user-data' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))
// Voice capture reads the app entry's env config; nothing here records audio.
vi.mock('../../../inbox/transcription', () => ({ getVoiceRecordingReadiness: vi.fn() }))
// No CRDT runtime in this test: a note write lands on disk and in the index only.
vi.mock('../../../sync/crdt-provider', () => ({ getCrdtProvider: () => null }))
vi.mock('../../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

import * as database from '../../../database'
import * as vaultIndex from '../../../vault'
import { createNote } from '../../../vault/notes'
import { startProjectionRuntime, stopProjectionRuntime } from '../../../projections'
import { createNoteDerivedStateProjector } from '../../../projections/projectors/note-derived-state-projector'
import { getNoteCacheById, getNoteCacheByPath } from '../../../database/queries/notes'
import { createVaultServiceHandles } from '../../mcp/tools/handles-adapter'
import { buildWriteTools } from '../../mcp/tools/write-tools'
import { toMcpToolErrorContent } from '../../mcp/errors'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'
import { mintTurnWriteGrant, revokeAllTurnWriteGrants } from '../../turn-grants'
import { installVaultLockSource, invalidateVaultLocks } from '../../../vault-locks/registry'
import { writeLockRow } from '../../../vault-locks/store'

describe('read-only locks under Always allow (#2606)', () => {
  let vault: TestVaultResult
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let handles: ReturnType<typeof createVaultServiceHandles>
  let lockedNote: { id: string; file: string; bytes: string }

  function installRuntime(
    toolApprovalMode: 'always_accept' | 'ask',
    trust: { conversation?: string[]; vault?: string[] }
  ) {
    const runtime = new AgentRuntime({
      conversations: {
        getById: vi.fn(() => ({ id: 'conversation-1', trustList: trust.conversation ?? [] })),
        addToTrustList: vi.fn()
      } as unknown as ConversationStore,
      messages: {} as MessageStore,
      getPreferences: () => ({ accessMode: 'vault_only', toolApprovalMode }),
      getVaultTrustList: () => trust.vault ?? []
    })
    runtime.install()
    const gate = mocks.setWriteGate.mock.calls.at(-1)?.[0]
    if (!gate) throw new Error('write gate was not installed')
    return buildWriteTools(handles, gate)
  }

  function tool(tools: ReturnType<typeof buildWriteTools>, name: string) {
    const found = tools.find((entry) => entry.name === name)
    if (!found) throw new Error(`${name} is not registered`)
    return found
  }

  async function refusal(call: Promise<unknown>): Promise<unknown> {
    return call.then(
      () => {
        throw new Error('the write was applied')
      },
      (error: unknown) => error
    )
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    revokeAllTurnWriteGrants()
    vault = createTestVault('always-allow-locks')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(data.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(index.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    const note = await createNote({ title: 'Locked', content: 'Owner text.' })
    const file = path.join(vault.path, note.path)
    lockedNote = { id: note.id, file, bytes: fs.readFileSync(file, 'utf8') }
    fs.mkdirSync(path.join(vault.path, 'archive'), { recursive: true })

    // The lookups `installVaultLockFileGuard` wires in the app, on the test index.
    installVaultLockSource({
      dataDb: () => asClientDb(data.db),
      notePathOf: (noteId) => getNoteCacheById(index.db, noteId)?.path ?? null,
      noteIdAtPath: (relativePath) => getNoteCacheByPath(index.db, relativePath)?.id ?? null
    })
    writeLockRow(asClientDb(data.db), 'note', note.id, true)
    writeLockRow(asClientDb(data.db), 'folder', 'archive', true)
    invalidateVaultLocks()
    handles = createVaultServiceHandles({ dataDb: asClientDb(data.db), indexDb: index.db })
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    vi.restoreAllMocks()
    index.close()
    data.close()
    vault.cleanup()
  })

  function expectLockRefusal(error: unknown): void {
    expect(JSON.parse(toMcpToolErrorContent(error).content[0].text)).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: VAULT_LOCKED_NOTE_MESSAGE
    })
  }

  it('auto-approve for every write: update, rename and delete of a locked note are refused by the real handles', async () => {
    const tools = installRuntime('always_accept', {})
    const ctx = () => ({ writeGrant: mintTurnWriteGrant('conversation-1'), windowId: null })

    expectLockRefusal(
      await refusal(
        tool(tools, 'vault_update_note').handler(
          { id: lockedNote.id, mode: 'append', content_markdown: 'agent text' },
          ctx()
        )
      )
    )
    expectLockRefusal(
      await refusal(
        tool(tools, 'vault_rename_note').handler({ id: lockedNote.id, title: 'Renamed' }, ctx())
      )
    )
    expectLockRefusal(
      await refusal(tool(tools, 'vault_delete_note').handler({ id: lockedNote.id }, ctx()))
    )

    expect(fs.readFileSync(lockedNote.file, 'utf8')).toBe(lockedNote.bytes)
    expect(getNoteCacheById(index.db, lockedNote.id)?.title).toBe('Locked')
    expect(fs.existsSync(path.join(path.dirname(lockedNote.file), 'Renamed.md'))).toBe(false)
  })

  it('an "Always allow" grant for the tool, per conversation or per vault, still refuses a locked folder', async () => {
    for (const trust of [
      { conversation: ['vault_create_note'] },
      { vault: ['vault_create_note'] }
    ]) {
      const tools = installRuntime('ask', trust)

      const error = await refusal(
        tool(tools, 'vault_create_note').handler(
          { title: 'Into the archive', content_markdown: 'body', folder_path: 'archive' },
          { writeGrant: mintTurnWriteGrant('conversation-1'), windowId: null }
        )
      )

      expect(mocks.broadcastAgentEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'tool_call_pending_approval' })
      )
      expectLockRefusal(error)
    }
    expect(fs.readdirSync(path.join(vault.path, 'archive'))).toEqual([])
  })

  it('the same tools still write once the lock is gone', async () => {
    writeLockRow(asClientDb(data.db), 'folder', 'archive', false)
    invalidateVaultLocks()
    const tools = installRuntime('always_accept', {})

    await tool(tools, 'vault_create_note').handler(
      { title: 'Into the archive', content_markdown: 'body', folder_path: 'archive' },
      { writeGrant: mintTurnWriteGrant('conversation-1'), windowId: null }
    )

    expect(fs.readdirSync(path.join(vault.path, 'archive'))).toEqual(['Into the archive.md'])
  })
})
