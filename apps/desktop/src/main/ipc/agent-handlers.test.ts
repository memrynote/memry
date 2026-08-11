import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron } from '@tests/utils/mock-electron'

const mocks = vi.hoisted(() => ({
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
  acceptDisclosure: vi.fn(() => ({ accepted: true })),
  getAgentPreferences: vi.fn(() => ({
    accessMode: 'vault_only',
    toolApprovalMode: 'always_accept'
  })),
  setAgentPreferences: vi.fn(
    (input: {
      accessMode?: 'vault_only' | 'computer_access'
      toolApprovalMode?: 'always_accept' | 'ask'
    }) => ({
      accessMode: input.accessMode ?? 'vault_only',
      toolApprovalMode: input.toolApprovalMode ?? 'always_accept'
    })
  )
}))

vi.mock('electron', () => ({
  BrowserWindow: mockElectron.BrowserWindow,
  ipcMain: mockElectron.ipcMain
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
vi.mock('../agent/settings', () => ({
  getAgentPreferences: mocks.getAgentPreferences,
  setAgentPreferences: mocks.setAgentPreferences
}))

import { AgentChannels } from '@memry/contracts/ipc-agent'

import { broadcastAgentEvent } from '../agent/runtime/event-bus'
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
  const backendStatuses = {
    claude_cli: {
      backend: 'claude_cli',
      available: true,
      reason: null,
      detail: null,
      version: '2.1.138',
      minimumRequired: '2.1.0'
    },
    codex_cli: {
      backend: 'codex_cli',
      available: true,
      reason: null,
      detail: null,
      version: '0.130.0',
      minimumRequired: '0.130.0'
    },
    local_openai_compatible: {
      backend: 'local_openai_compatible',
      available: true,
      reason: null,
      detail: 'http://localhost:11434/v1'
    }
  }
  const deps = {
    runtime: {
      cancelTurn: vi.fn(),
      resolveApproval: vi.fn(),
      trackSubprocess: vi.fn(),
      untrackSubprocess: vi.fn(),
      trackTurn: vi.fn(),
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
      getById: vi.fn(() => ({
        id: 'conversation-1',
        backend: 'claude_cli',
        backendModel: null,
        trustList: []
      })),
      update: vi.fn((id, patch) => ({ id, ...patch, trustList: [] })),
      addToTrustList: vi.fn(),
      removeFromTrustList: vi.fn()
    },
    messages: {
      listByConversation: vi.fn(() => []),
      append: vi.fn((input) => ({ id: 'message-2', ...input }))
    },
    backends: {
      get: vi.fn((id: keyof typeof backendStatuses) => ({
        getStatus: vi.fn(async () => backendStatuses[id])
      })),
      list: vi.fn(() => [])
    },
    previewNoteUpdate: vi.fn(() => ({
      title: 'Note',
      current: 'old',
      candidate: 'old\n\nnew'
    })),
    localProvider: {
      getSettings: vi.fn(async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: '',
        apiKeyConfigured: false,
        allowNonLoopback: false
      })),
      setSettings: vi.fn(async (input) => ({ ...input, apiKeyConfigured: false })),
      listModels: vi.fn(async () => ({ models: [] })),
      testConnection: vi.fn(async () => ({
        connected: true,
        modelAvailable: true,
        streamingSupported: true,
        toolCallingSupported: false,
        toolContinuationSupported: false,
        toolsEnabled: false,
        detail: null
      })),
      probeTools: vi.fn(async () => ({
        connected: true,
        modelAvailable: true,
        streamingSupported: true,
        toolCallingSupported: true,
        toolContinuationSupported: true,
        toolsEnabled: true,
        detail: null
      }))
    },
    preferences: {
      get: vi.fn(() => ({ accessMode: 'vault_only', toolApprovalMode: 'always_accept' })),
      set: vi.fn((input) => ({
        accessMode: 'vault_only',
        toolApprovalMode: 'always_accept',
        ...input
      }))
    },
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
    await expect(findHandler(AgentChannels.invoke.GET_BACKEND_STATUSES)(null)).resolves.toEqual({
      claude_cli: expect.objectContaining({ backend: 'claude_cli', available: false }),
      codex_cli: expect.objectContaining({ backend: 'codex_cli', available: false }),
      local_openai_compatible: expect.objectContaining({
        backend: 'local_openai_compatible',
        available: false
      })
    })
    expect(findHandler(AgentChannels.invoke.GET_PREFERENCES)(null)).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
    expect(
      findHandler(AgentChannels.invoke.SET_PREFERENCES)(null, { toolApprovalMode: 'ask' })
    ).toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
    expect(mocks.setAgentPreferences).toHaveBeenCalledWith({ toolApprovalMode: 'ask' })
  })

  it('returns unified backend statuses keyed by backend id', async () => {
    registerAgentHandlers(deps)

    await expect(findHandler(AgentChannels.invoke.GET_BACKEND_STATUSES)(null)).resolves.toEqual(
      backendStatuses
    )
    expect(deps.backends.get).toHaveBeenCalledWith('claude_cli')
    expect(deps.backends.get).toHaveBeenCalledWith('codex_cli')
    expect(deps.backends.get).toHaveBeenCalledWith('local_openai_compatible')
  })

  it('returns suggested CLI backend models with custom model support', async () => {
    registerAgentHandlers(deps)

    await expect(
      findHandler(AgentChannels.invoke.LIST_BACKEND_MODELS)(null, { backend: 'claude_cli' })
    ).resolves.toEqual({
      backend: 'claude_cli',
      supportsCustomModel: true,
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
        { id: 'opus', label: 'Opus' }
      ]
    })
    await expect(
      findHandler(AgentChannels.invoke.LIST_BACKEND_MODELS)(null, { backend: 'codex_cli' })
    ).resolves.toEqual({
      backend: 'codex_cli',
      supportsCustomModel: true,
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5' },
        { id: 'gpt-5.4', label: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
      ]
    })
  })

  it('gets and sets agent preferences', async () => {
    registerAgentHandlers(deps)

    await expect(findHandler(AgentChannels.invoke.GET_PREFERENCES)(null)).resolves.toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
    await expect(
      findHandler(AgentChannels.invoke.SET_PREFERENCES)(null, { toolApprovalMode: 'ask' })
    ).resolves.toEqual({ accessMode: 'vault_only', toolApprovalMode: 'ask' })
    expect(deps.preferences.set).toHaveBeenCalledWith({ toolApprovalMode: 'ask' })
  })

  it('runs a turn with snapshotted attachments', async () => {
    registerAgentHandlers(deps)

    const result = await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: [{ kind: 'current_note', ref_id: 'current', label: 'Current note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.snapshotAttachments).toHaveBeenCalledWith([
      { kind: 'current_note', ref_id: 'current', label: 'Current note' }
    ])
    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: deps.conversations,
        messages: deps.messages,
        backends: deps.backends,
        trackRunHandle: expect.any(Function)
      }),
      expect.objectContaining({
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' },
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
    expect(deps.runtime.trackTurn).toHaveBeenCalledWith('conversation-1', expect.any(Promise))
  })

  it('stores selected CLI model metadata on the conversation before running a turn', async () => {
    registerAgentHandlers(deps)

    await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low', model: 'sonnet' }
    })

    expect(deps.conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { backend: 'claude_cli', backendModel: 'sonnet' },
      ['backendModel']
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
    const handle = {
      events: (async function* () {})(),
      stderr: (async function* () {})(),
      pid: 9,
      kill,
      waitExit: vi.fn(),
      cleanup
    }
    registerAgentHandlers(deps)

    await findHandler(AgentChannels.invoke.SEND_TURN)(null, {
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: []
    })
    const turnDeps = mocks.runTurn.mock.calls[0][0]
    const subprocess = turnDeps.trackRunHandle('conversation-1', handle)
    await subprocess.cleanup()

    expect(deps.runtime.trackSubprocess).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        events: expect.any(Object),
        stderr: expect.any(Object),
        pid: 9,
        kill,
        waitExit: expect.any(Function)
      })
    )
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

  it('records the sender window so streamed deltas reach only it', async () => {
    registerAgentHandlers(deps)
    const viewer = new mockElectron.BrowserWindow()
    const other = new mockElectron.BrowserWindow()
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(viewer as never)
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([viewer, other] as never)

    const result = await findHandler(AgentChannels.invoke.SET_STREAM_TARGET)(
      { sender: viewer.webContents },
      { conversationId: 'conversation-1' }
    )
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      text: 'hello'
    })

    expect(result).toEqual({ ok: true })
    expect(viewer.webContents.send).toHaveBeenCalledWith(
      AgentChannels.events.AGENT_EVENT,
      expect.objectContaining({ kind: 'assistant_text_delta' })
    )
    expect(other.webContents.send).not.toHaveBeenCalled()
  })

  it('records the sender window even while the agent runtime is unavailable', async () => {
    registerUnavailableAgentHandlers('missing key')
    const viewer = new mockElectron.BrowserWindow()
    const other = new mockElectron.BrowserWindow()
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(viewer as never)
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([viewer, other] as never)

    const result = await findHandler(AgentChannels.invoke.SET_STREAM_TARGET)(
      { sender: viewer.webContents },
      { conversationId: 'conversation-2' }
    )
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: 'conversation-2',
      messageId: 'message-2',
      text: 'hello'
    })

    expect(result).toEqual({ ok: true })
    expect(viewer.webContents.send).toHaveBeenCalledWith(
      AgentChannels.events.AGENT_EVENT,
      expect.objectContaining({ kind: 'assistant_text_delta' })
    )
    expect(other.webContents.send).not.toHaveBeenCalled()
  })

  it('leaves a sender whose window cannot be resolved unrecorded', async () => {
    registerAgentHandlers(deps)
    const first = new mockElectron.BrowserWindow()
    const second = new mockElectron.BrowserWindow()
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([first, second] as never)

    // Two live windows and no match: resolveSenderWindowId gives up, so the
    // sender stays unknown and keeps receiving the full stream.
    await findHandler(AgentChannels.invoke.SET_STREAM_TARGET)(
      { sender: { id: 999 } },
      { conversationId: 'conversation-3' }
    )
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: 'conversation-3',
      messageId: 'message-3',
      text: 'hello'
    })

    expect(first.webContents.send).toHaveBeenCalledWith(
      AgentChannels.events.AGENT_EVENT,
      expect.objectContaining({ kind: 'assistant_text_delta' })
    )
    expect(second.webContents.send).toHaveBeenCalledWith(
      AgentChannels.events.AGENT_EVENT,
      expect.objectContaining({ kind: 'assistant_text_delta' })
    )
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
