import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ db: true })),
  getIndexDatabase: vi.fn(() => ({ indexDb: true })),
  getOrInitializeLocalVaultKey: vi.fn(async () => new Uint8Array(32).fill(1)),
  secureCleanup: vi.fn(),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1'),
  createConversationStore: vi.fn(() => ({ store: 'conversations' })),
  createMessageStore: vi.fn(() => ({ store: 'messages' })),
  createVaultServiceHandles: vi.fn(() => ({
    notes: {
      read: vi.fn(async () => ({
        title: 'Note',
        content_markdown: 'old'
      }))
    }
  })),
  registerAgentHandlers: vi.fn(),
  registerUnavailableAgentHandlers: vi.fn(),
  unregisterAgentHandlers: vi.fn(),
  getPublicStatus: vi.fn(() => ({
    url: 'http://127.0.0.1:54321',
    ['token']: 'local-auth-value',
    toolCount: 20
  })),
  detectClaudeBinary: vi.fn(async () => ({
    detected: true,
    version: '2.1.138',
    meetsMinimum: true,
    minimumRequired: '2.1.0',
    installHint: null
  })),
  detectCodexBinary: vi.fn(async () => ({
    detected: true,
    version: '0.130.0',
    meetsMinimum: true,
    minimumRequired: '0.130.0',
    installHint: null
  })),
  spawnClaudeTurn: vi.fn(async () => ({
    pid: 7,
    proc: {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      kill: vi.fn(),
      once: vi.fn()
    },
    cleanup: vi.fn()
  })),
  spawnCodexTurn: vi.fn(async () => ({
    pid: 8,
    proc: {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      kill: vi.fn(),
      once: vi.fn()
    },
    cleanup: vi.fn()
  })),
  runtimeInstall: vi.fn(),
  runtimeKillAll: vi.fn(async () => {})
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: mocks.getIndexDatabase
}))
vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: mocks.getOrInitializeLocalVaultKey,
  secureCleanup: mocks.secureCleanup
}))
vi.mock('./storage/vault-id', () => ({ getOrCreateVaultUuid: mocks.getOrCreateVaultUuid }))
vi.mock('./storage/conversation-store', () => ({
  createConversationStore: mocks.createConversationStore
}))
vi.mock('./storage/message-store', () => ({ createMessageStore: mocks.createMessageStore }))
vi.mock('../ipc/agent-handlers', () => ({
  registerAgentHandlers: mocks.registerAgentHandlers,
  registerUnavailableAgentHandlers: mocks.registerUnavailableAgentHandlers,
  unregisterAgentHandlers: mocks.unregisterAgentHandlers
}))
vi.mock('./mcp/lifecycle', () => ({ getPublicStatus: mocks.getPublicStatus }))
vi.mock('./mcp/tools/handles-adapter', () => ({
  createVaultServiceHandles: mocks.createVaultServiceHandles
}))
vi.mock('./cli/claude-binary', () => ({ detectClaudeBinary: mocks.detectClaudeBinary }))
vi.mock('./cli/codex-binary', () => ({ detectCodexBinary: mocks.detectCodexBinary }))
vi.mock('./cli/spawn', () => ({ spawnClaudeTurn: mocks.spawnClaudeTurn }))
vi.mock('./cli/codex-spawn', () => ({ spawnCodexTurn: mocks.spawnCodexTurn }))
vi.mock('./runtime/runtime', () => ({
  AgentRuntime: vi.fn().mockImplementation(function AgentRuntime() {
    return {
      install: mocks.runtimeInstall,
      killAll: mocks.runtimeKillAll
    }
  })
}))

import { startAgent } from './bootstrap'

describe('startAgent', () => {
  it('registers unavailable IPC handlers when the local vault key cannot be created', async () => {
    mocks.getOrInitializeLocalVaultKey.mockRejectedValueOnce(new Error('keychain locked'))

    const agent = await startAgent()

    expect(mocks.registerUnavailableAgentHandlers).toHaveBeenCalledWith('keychain locked')
    expect(mocks.getOrCreateVaultUuid).toHaveBeenCalledWith({ db: true })
    expect(mocks.createConversationStore).not.toHaveBeenCalled()
    expect(mocks.runtimeInstall).not.toHaveBeenCalled()

    await agent.shutdown()

    expect(mocks.unregisterAgentHandlers).toHaveBeenCalled()
  })

  it('creates stores, installs runtime, and registers IPC handlers', async () => {
    await startAgent()

    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledWith({ db: true }, 'vault-1')
    expect(mocks.getOrCreateVaultUuid).toHaveBeenCalledWith({ db: true })
    expect(mocks.createConversationStore).toHaveBeenCalledWith({
      db: { db: true },
      vaultKey: expect.any(Uint8Array),
      deviceId: 'desktop'
    })
    expect(mocks.createVaultServiceHandles).toHaveBeenCalledWith({
      dataDb: { db: true },
      indexDb: { indexDb: true }
    })
    expect(mocks.runtimeInstall).toHaveBeenCalled()
    expect(mocks.registerAgentHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: { store: 'conversations' },
        messages: { store: 'messages' },
        vaultId: 'vault-1'
      })
    )
  })

  it('adapts Claude subprocess spawn to the turn interface', async () => {
    await startAgent()
    const deps = mocks.registerAgentHandlers.mock.calls[0][0]

    await deps.backends.get('claude_cli').runTurn({
      prompt: 'hello',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'claude_cli', claudeEffort: 'low', model: 'sonnet' }
    })

    expect(mocks.spawnClaudeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: 'claude',
        mcpServerUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'local-auth-value',
        conversationId: 'conversation-1',
        windowId: 'window-1',
        effort: 'low',
        model: 'sonnet',
        prompt: 'hello'
      })
    )
  })

  it('adapts Codex subprocess spawn with native MCP only for normal turns', async () => {
    await startAgent()
    const deps = mocks.registerAgentHandlers.mock.calls[0][0]

    await deps.backends.get('codex_cli').runTurn({
      prompt: 'hello',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'high', model: 'gpt-5.5' }
    })
    await deps.backends.get('codex_cli').generateTitle({
      prompt: 'title',
      conversationId: 'conversation-1',
      windowId: 'window-1',
      options: { backend: 'codex_cli', reasoningEffort: 'medium' }
    })

    expect(mocks.spawnCodexTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        binaryPath: 'codex',
        prompt: 'hello',
        reasoningEffort: 'high',
        model: 'gpt-5.5',
        mcp: {
          serverUrl: 'http://127.0.0.1:54321',
          authorizationValue: 'local-auth-value',
          conversationId: 'conversation-1',
          windowId: 'window-1'
        }
      })
    )
    expect(mocks.spawnCodexTurn).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ mcp: expect.anything() })
    )
  })

  it('previews note updates for agent diff approvals', async () => {
    await startAgent()
    const deps = mocks.registerAgentHandlers.mock.calls[0][0]

    const preview = await deps.previewNoteUpdate({
      id: 'note-1',
      mode: 'append',
      content_markdown: 'new'
    })

    expect(preview).toEqual({
      title: 'Note',
      current: 'old',
      candidate: 'old\n\nnew'
    })
  })

  it('kills runtime and unregisters handlers on shutdown', async () => {
    const agent = await startAgent()

    await agent.shutdown()

    expect(mocks.runtimeKillAll).toHaveBeenCalled()
    expect(mocks.unregisterAgentHandlers).toHaveBeenCalled()
  })
})
