import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ db: true })),
  getOrDeriveVaultKey: vi.fn(async () => new Uint8Array(32).fill(1)),
  secureCleanup: vi.fn(),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1'),
  createConversationStore: vi.fn(() => ({ store: 'conversations' })),
  createMessageStore: vi.fn(() => ({ store: 'messages' })),
  registerAgentHandlers: vi.fn(),
  unregisterAgentHandlers: vi.fn(),
  getPublicStatus: vi.fn(() => ({
    url: 'http://127.0.0.1:54321',
    ['token']: 'local-auth-value',
    toolCount: 19
  })),
  detectClaudeBinary: vi.fn(async () => ({
    detected: true,
    version: '2.1.138',
    meetsMinimum: true,
    minimumRequired: '2.1.0',
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
  runtimeInstall: vi.fn(),
  runtimeKillAll: vi.fn(async () => {})
}))

vi.mock('../database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('../crypto', () => ({
  getOrDeriveVaultKey: mocks.getOrDeriveVaultKey,
  secureCleanup: mocks.secureCleanup
}))
vi.mock('./storage/vault-id', () => ({ getOrCreateVaultUuid: mocks.getOrCreateVaultUuid }))
vi.mock('./storage/conversation-store', () => ({
  createConversationStore: mocks.createConversationStore
}))
vi.mock('./storage/message-store', () => ({ createMessageStore: mocks.createMessageStore }))
vi.mock('../ipc/agent-handlers', () => ({
  registerAgentHandlers: mocks.registerAgentHandlers,
  unregisterAgentHandlers: mocks.unregisterAgentHandlers
}))
vi.mock('./mcp/lifecycle', () => ({ getPublicStatus: mocks.getPublicStatus }))
vi.mock('./cli/claude-binary', () => ({ detectClaudeBinary: mocks.detectClaudeBinary }))
vi.mock('./cli/spawn', () => ({ spawnClaudeTurn: mocks.spawnClaudeTurn }))
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
  it('creates stores, installs runtime, and registers IPC handlers', async () => {
    await startAgent()

    expect(mocks.getOrCreateVaultUuid).toHaveBeenCalledWith({ db: true })
    expect(mocks.createConversationStore).toHaveBeenCalledWith({
      db: { db: true },
      vaultKey: expect.any(Uint8Array),
      deviceId: 'desktop'
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

    await deps.spawn({
      prompt: 'hello',
      conversationId: 'conversation-1',
      windowId: 'window-1'
    })

    expect(mocks.spawnClaudeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: 'claude',
        mcpServerUrl: 'http://127.0.0.1:54321',
        authorizationValue: 'local-auth-value',
        conversationId: 'conversation-1',
        windowId: 'window-1',
        prompt: 'hello'
      })
    )
  })

  it('kills runtime and unregisters handlers on shutdown', async () => {
    const agent = await startAgent()

    await agent.shutdown()

    expect(mocks.runtimeKillAll).toHaveBeenCalled()
    expect(mocks.unregisterAgentHandlers).toHaveBeenCalled()
  })
})
