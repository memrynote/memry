import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn(),
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({ setWriteGate: mocks.setWriteGate }))
vi.mock('../event-bus', () => ({ broadcastAgentEvent: mocks.broadcastAgentEvent }))

import type { VaultServiceHandles } from '../../mcp/tools/handles'
import { buildWriteTools } from '../../mcp/tools/write-tools'
import { toMcpToolErrorContent } from '../../mcp/errors'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'
import { mintTurnWriteGrant, revokeAllTurnWriteGrants } from '../../turn-grants'
import {
  assertFolderWritable,
  assertNoteWritable,
  installVaultLockSource,
  invalidateVaultLocks
} from '../../../vault-locks/registry'
import { writeLockRow } from '../../../vault-locks/store'

/**
 * "Always allow" (FB-004) is an approval, and the lock sits below every
 * approval: an auto-approved or trusted write still reaches the lock check in
 * the vault layer and is refused there (#2606).
 */
describe('read-only locks under Always allow (#2606)', () => {
  let data: TestDatabaseResult
  const written: string[] = []

  const handles = {
    notes: {
      update: vi.fn(async (args: { id: string }) => {
        assertNoteWritable(args.id)
        written.push(`update:${args.id}`)
        return {}
      }),
      create: vi.fn(async (args: { folder_path?: string }) => {
        assertFolderWritable(args.folder_path)
        written.push(`create:${args.folder_path}`)
        return { id: 'created' }
      })
    }
  } as unknown as VaultServiceHandles

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

  beforeEach(() => {
    vi.clearAllMocks()
    revokeAllTurnWriteGrants()
    written.length = 0
    data = createTestDataDb()
    installVaultLockSource({
      dataDb: () => asClientDb(data.db),
      notePathOf: (noteId) => (noteId === 'note-locked' ? 'notes/locked.md' : null),
      noteIdAtPath: () => null
    })
    writeLockRow(asClientDb(data.db), 'note', 'note-locked', true)
    writeLockRow(asClientDb(data.db), 'folder', 'archive', true)
    invalidateVaultLocks()
  })

  afterEach(() => {
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    data.close()
  })

  it('auto-approve for every write still refuses a locked note with PERMISSION_DENIED', async () => {
    const tools = installRuntime('always_accept', {})

    const error = await refusal(
      tool(tools, 'vault_update_note').handler(
        { id: 'note-locked', mode: 'append', content_markdown: 'agent text' },
        { writeGrant: mintTurnWriteGrant('conversation-1'), windowId: null }
      )
    )

    expect(handles.notes.update).toHaveBeenCalled()
    expect(written).toEqual([])
    expect(JSON.parse(toMcpToolErrorContent(error).content[0].text)).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: VAULT_LOCKED_NOTE_MESSAGE
    })
  })

  it('an "Always allow" grant for the tool, per conversation or per vault, still refuses a locked folder', async () => {
    for (const trust of [
      { conversation: ['vault_create_note'] },
      { vault: ['vault_create_note'] }
    ]) {
      const tools = installRuntime('ask', trust)

      const error = await refusal(
        tool(tools, 'vault_create_note').handler(
          { title: 'Into the archive', content_markdown: 'body', folder_path: 'archive/2026' },
          { writeGrant: mintTurnWriteGrant('conversation-1'), windowId: null }
        )
      )

      expect(mocks.broadcastAgentEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'tool_call_pending_approval' })
      )
      expect(JSON.parse(toMcpToolErrorContent(error).content[0].text)).toMatchObject({
        code: 'PERMISSION_DENIED',
        message: VAULT_LOCKED_NOTE_MESSAGE
      })
    }
    expect(written).toEqual([])
  })
})
