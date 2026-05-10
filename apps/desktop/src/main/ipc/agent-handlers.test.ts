import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron } from '@tests/utils/mock-electron'

const mocks = vi.hoisted(() => ({
  detectClaudeBinary: vi.fn(async () => ({
    detected: true,
    version: '2.1.138',
    meetsMinimum: true,
    minimumRequired: '2.1.0',
    installHint: null
  })),
  runTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
  snapshotAttachments: vi.fn(async () => [
    {
      kind: 'current_note',
      refId: 'current',
      label: 'Current note',
      snapshotAt: 1,
      snapshot: { mode: 'reference_only', id: 'current' }
    }
  ]),
  getDisclosureState: vi.fn(() => ({ accepted: false })),
  acceptDisclosure: vi.fn(() => ({ accepted: true }))
}))

vi.mock('electron', () => ({
  ipcMain: mockElectron.ipcMain
}))
vi.mock('../agent/cli/claude-binary', () => ({
  detectClaudeBinary: mocks.detectClaudeBinary
}))
vi.mock('../agent/runtime/turn', () => ({
  runTurn: mocks.runTurn
}))
vi.mock('../agent/runtime/attachment-snapshotter', () => ({
  snapshotAttachments: mocks.snapshotAttachments
}))
vi.mock('../agent/runtime/disclosure-state', () => ({
  getDisclosureState: mocks.getDisclosureState,
  acceptDisclosure: mocks.acceptDisclosure
}))

import { AgentChannels } from '@memry/contracts/ipc-agent'

import { registerAgentHandlers, unregisterAgentHandlers } from './agent-handlers'

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockElectron.ipcMain.handle.mock.calls.find(([registered]) => registered === channel)
  expect(call).toBeDefined()
  return call![1] as (...args: unknown[]) => unknown
}

describe('agent IPC handlers', () => {
  const deps = {
    runtime: {
      cancelTurn: vi.fn(),
      resolveApproval: vi.fn(),
      getPendingApproval: vi.fn(() => ({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        name: 'vault_update_note',
        args: {
          id: 'note-1',
          mode: 'append',
          content_markdown: 'new'
        },
        requiresDiff: true
      }))
    },
    conversations: {
      listByVault: vi.fn(() => [{ id: 'conversation-1' }]),
      create: vi.fn(() => ({ id: 'conversation-2' })),
      getById: vi.fn(() => ({ id: 'conversation-1', trustList: [] })),
      addToTrustList: vi.fn(),
      removeFromTrustList: vi.fn()
    },
    messages: {
      listByConversation: vi.fn(() => [{ id: 'message-1' }])
    },
    previewNoteUpdate: vi.fn(() => ({
      title: 'Note',
      current: 'old',
      candidate: 'old\n\nnew'
    })),
    spawn: vi.fn(),
    routeToolCall: vi.fn(),
    vaultId: 'vault-1'
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterAgentHandlers()
  })

  it('registers every agent invoke channel', () => {
    registerAgentHandlers(deps)

    for (const channel of Object.values(AgentChannels.invoke)) {
      expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('runs a turn with snapshotted attachments', async () => {
    registerAgentHandlers(deps)

    const result = await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: [{ kind: 'current_note', ref_id: 'current', label: 'Current note' }]
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.snapshotAttachments).toHaveBeenCalledWith([
      { kind: 'current_note', ref_id: 'current', label: 'Current note' }
    ])
    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: deps.conversations,
        messages: deps.messages,
        spawnSubprocess: deps.spawn,
        toolHandlers: { routeToolCall: deps.routeToolCall }
      }),
      expect.objectContaining({
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [
          {
            kind: 'current_note',
            refId: 'current',
            label: 'Current note',
            snapshotAt: 1,
            snapshot: { mode: 'reference_only', id: 'current' }
          }
        ]
      })
    )
  })

  it('forwards approval decisions to the runtime', async () => {
    registerAgentHandlers(deps)

    await findHandler(AgentChannels.invoke.APPROVE_TOOL)(null, {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      decision: { kind: 'allow' }
    })

    expect(deps.runtime.resolveApproval).toHaveBeenCalledWith('tool-1', { kind: 'allow' })
  })

  it('previews pending vault_update_note diffs', async () => {
    registerAgentHandlers(deps)

    const result = await findHandler(AgentChannels.invoke.PREVIEW_DIFF)(null, {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1'
    })

    expect(deps.previewNoteUpdate).toHaveBeenCalledWith({
      id: 'note-1',
      mode: 'append',
      content_markdown: 'new'
    })
    expect(result).toEqual({
      title: 'Note',
      current: 'old',
      candidate: 'old\n\nnew'
    })
  })
})
