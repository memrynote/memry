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
  BrowserWindow: mockElectron.BrowserWindow,
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

import {
  registerAgentHandlers,
  registerUnavailableAgentHandlers,
  unregisterAgentHandlers
} from './agent-handlers'

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
      trackSubprocess: vi.fn(),
      untrackSubprocess: vi.fn(),
      acquireTurnLock: vi.fn(),
      releaseTurnLock: vi.fn(),
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
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(null)
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([])
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

  it('registers graceful unavailable handlers for every agent invoke channel', async () => {
    registerUnavailableAgentHandlers('missing key')

    for (const channel of Object.values(AgentChannels.invoke)) {
      expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }

    await expect(findHandler(AgentChannels.invoke.LIST_CONVERSATIONS)(null)).resolves.toEqual([])
    await expect(findHandler(AgentChannels.invoke.SEND_TURN)(null)).resolves.toEqual({
      ok: false,
      error: 'Agent runtime unavailable: missing key'
    })
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
        spawnSubprocess: expect.any(Function),
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

  it('returns a busy result when another window already has a turn in flight', async () => {
    deps.runtime.acquireTurnLock.mockImplementationOnce(() => {
      throw new Error('There is already a turn in flight for conversation conversation-1')
    })
    registerAgentHandlers(deps)

    const result = await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: []
    })

    expect(result).toEqual({
      ok: false,
      error: 'There is already a turn in flight for conversation conversation-1'
    })
    expect(mocks.snapshotAttachments).not.toHaveBeenCalled()
    expect(mocks.runTurn).not.toHaveBeenCalled()
  })

  it('releases the conversation lock after the turn settles', async () => {
    registerAgentHandlers(deps)

    await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: []
    })
    await Promise.resolve()

    expect(deps.runtime.acquireTurnLock).toHaveBeenCalledWith('conversation-1')
    expect(deps.runtime.releaseTurnLock).toHaveBeenCalledWith('conversation-1')
  })

  it('tracks and untracks subprocesses spawned for a turn', async () => {
    const cleanup = vi.fn()
    const kill = vi.fn()
    deps.spawn.mockResolvedValue({
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      pid: 9,
      kill,
      waitExit: vi.fn(),
      cleanup
    })
    registerAgentHandlers(deps)

    await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: []
    })
    const turnDeps = mocks.runTurn.mock.calls[0][0]
    const subprocess = await turnDeps.spawnSubprocess({
      prompt: 'prompt',
      conversationId: 'conversation-1',
      windowId: 'window-1'
    })
    await subprocess.cleanup()

    expect(deps.runtime.trackSubprocess).toHaveBeenCalledWith('conversation-1', {
      stdout: expect.any(Object),
      stderr: expect.any(Object),
      pid: 9,
      kill,
      waitExit: expect.any(Function),
      cleanup
    })
    expect(cleanup).toHaveBeenCalled()
    expect(deps.runtime.untrackSubprocess).toHaveBeenCalledWith(9)
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

  it('returns the calling BrowserWindow id for agent turns', async () => {
    registerAgentHandlers(deps)
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue({ id: 42 } as never)

    const result = await findHandler(AgentChannels.invoke.GET_WINDOW_ID)({
      sender: { id: 123 }
    })

    expect(mockElectron.BrowserWindow.fromWebContents).toHaveBeenCalledWith({ id: 123 })
    expect(result).toEqual({ windowId: '42' })
  })

  it('falls back to matching sender webContents when resolving window id', async () => {
    registerAgentHandlers(deps)
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([
      { id: 7, webContents: { id: 123 } }
    ] as never)

    const result = await findHandler(AgentChannels.invoke.GET_WINDOW_ID)({
      sender: { id: 123 }
    })

    expect(result).toEqual({ windowId: '7' })
  })
})
