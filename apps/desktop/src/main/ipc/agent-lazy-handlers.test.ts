import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockElectron } from '@tests/utils/mock-electron'

const mocks = vi.hoisted(() => ({
  ensureLazyAgentServicesStarted: vi.fn(async () => undefined),
  getAgentPreferences: vi.fn(() => ({
    accessMode: 'vault_only',
    toolApprovalMode: 'always_accept'
  })),
  setAgentPreferences: vi.fn((input: { toolApprovalMode?: 'ask' | 'always_accept' }) => ({
    accessMode: 'vault_only',
    toolApprovalMode: input.toolApprovalMode ?? 'always_accept'
  })),
  getDisclosureState: vi.fn(() => ({ accepted: false })),
  acceptDisclosure: vi.fn(() => ({ accepted: true }))
}))

vi.mock('electron', () => ({
  BrowserWindow: mockElectron.BrowserWindow,
  ipcMain: mockElectron.ipcMain
}))

vi.mock('../agent/lazy-services', () => ({
  ensureLazyAgentServicesStarted: mocks.ensureLazyAgentServicesStarted
}))

vi.mock('../agent/settings', () => ({
  getAgentPreferences: mocks.getAgentPreferences,
  setAgentPreferences: mocks.setAgentPreferences
}))

vi.mock('../agent/runtime/disclosure-state', () => ({
  getDisclosureState: mocks.getDisclosureState,
  acceptDisclosure: mocks.acceptDisclosure
}))

import { AgentChannels } from '@memry/contracts/ipc-agent'
import { registerLazyAgentHandlers, unregisterLazyAgentHandlers } from './agent-lazy-handlers'

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockElectron.ipcMain.handle.mock.calls.find(([registered]) => registered === channel)
  expect(call).toBeDefined()
  return call![1] as (...args: unknown[]) => unknown
}

describe('lazy agent IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(null)
    mockElectron.BrowserWindow.getAllWindows.mockReturnValue([])
  })

  afterEach(() => {
    unregisterLazyAgentHandlers()
  })

  it('registers and unregisters every agent invoke channel', () => {
    registerLazyAgentHandlers()

    for (const channel of Object.values(AgentChannels.invoke)) {
      expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }

    unregisterLazyAgentHandlers()

    for (const channel of Object.values(AgentChannels.invoke)) {
      expect(mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('starts lazy services before backend status bootstrap retries', async () => {
    registerLazyAgentHandlers()

    await expect(findHandler(AgentChannels.invoke.GET_BACKEND_STATUSES)()).rejects.toThrow(
      'errors:agent.runtimeStarting'
    )
    expect(mocks.ensureLazyAgentServicesStarted).toHaveBeenCalledTimes(1)
  })

  // The renderer's shouldRetryAgentBootstrap matches this exact code on the raw
  // rejection message. A channel that rejects with anything else drops out of
  // the bootstrap retry loop, so assert the literal on every throwing channel.
  it('rejects every lazy-start channel with the retryable runtime code', async () => {
    registerLazyAgentHandlers()

    const lazyStartChannels = [
      AgentChannels.invoke.CREATE_CONVERSATION,
      AgentChannels.invoke.LOAD_CONVERSATION,
      AgentChannels.invoke.CANCEL_TURN,
      AgentChannels.invoke.APPROVE_TOOL,
      AgentChannels.invoke.PREVIEW_DIFF,
      AgentChannels.invoke.EDIT_TRUST_LIST,
      AgentChannels.invoke.GET_BACKEND_STATUSES,
      AgentChannels.invoke.LIST_LOCAL_MODELS,
      AgentChannels.invoke.TEST_LOCAL_PROVIDER,
      AgentChannels.invoke.PROBE_LOCAL_PROVIDER
    ]

    for (const channel of lazyStartChannels) {
      await expect(findHandler(channel)(null, {})).rejects.toThrow('errors:agent.runtimeStarting')
    }
  })

  it('returns static CLI model suggestions without starting services', async () => {
    registerLazyAgentHandlers()

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
    expect(mocks.ensureLazyAgentServicesStarted).not.toHaveBeenCalled()
  })

  it('keeps preferences available while services are lazy', async () => {
    registerLazyAgentHandlers()

    await expect(findHandler(AgentChannels.invoke.GET_PREFERENCES)()).resolves.toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
    await expect(
      findHandler(AgentChannels.invoke.SET_PREFERENCES)(null, { toolApprovalMode: 'ask' })
    ).resolves.toEqual({
      accessMode: 'vault_only',
      toolApprovalMode: 'ask'
    })
    expect(mocks.setAgentPreferences).toHaveBeenCalledWith({ toolApprovalMode: 'ask' })
  })

  it('records a stream target without starting the runtime', () => {
    const window = new mockElectron.BrowserWindow()
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(window)
    registerLazyAgentHandlers()

    expect(
      findHandler(AgentChannels.invoke.SET_STREAM_TARGET)(
        { sender: window.webContents },
        { conversationId: 'conversation-1' }
      )
    ).toEqual({ ok: true })
    expect(mocks.ensureLazyAgentServicesStarted).not.toHaveBeenCalled()
  })

  it('starts services when resolving the sender window id', () => {
    const window = new mockElectron.BrowserWindow()
    mockElectron.BrowserWindow.fromWebContents.mockReturnValue(window)
    registerLazyAgentHandlers()

    expect(findHandler(AgentChannels.invoke.GET_WINDOW_ID)({ sender: window.webContents })).toEqual(
      {
        windowId: window.id.toString()
      }
    )
    expect(mocks.ensureLazyAgentServicesStarted).toHaveBeenCalledTimes(1)
  })
})
