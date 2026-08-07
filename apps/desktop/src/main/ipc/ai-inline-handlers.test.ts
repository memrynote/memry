import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIInlineChannels, AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'

import { isExpectedConditionError } from '../telemetry/expected-conditions'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    },
    BrowserWindow: {
      getAllWindows: vi.fn()
    },
    webContents: { send: vi.fn() },
    startChatServer: vi.fn(),
    stopChatServer: vi.fn(),
    getServerPort: vi.fn(),
    getDatabase: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    info: vi.fn(),
    trackMainError: vi.fn()
  }
})

// validate.ts routes every IPC envelope error to trackMainError; spy on it so the
// tests can assert what actually reaches error telemetry vs. what is suppressed.
vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: mocks.trackMainError
}))

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: mocks.BrowserWindow
}))

vi.mock('../ai-inline/ai-chat-server', () => ({
  startChatServer: mocks.startChatServer,
  stopChatServer: mocks.stopChatServer,
  getServerPort: mocks.getServerPort
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('../settings/settings-store', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: mocks.info, error: vi.fn(), warn: vi.fn(), debug: vi.fn() })
}))

import { registerAIInlineHandlers, unregisterAIInlineHandlers } from './ai-inline-handlers'

async function invoke(channel: string, input?: unknown) {
  const handler = mocks.handlers.get(channel)
  expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
  return handler?.({}, input)
}

describe('AI inline IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.getDatabase.mockReturnValue({ id: 'db' })
    mocks.getSetting.mockReturnValue(
      JSON.stringify({ enabled: true, provider: 'openai', apiKey: 'sk-real', model: 'gpt-4o-mini' })
    )
    mocks.BrowserWindow.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: mocks.webContents }
    ])
    mocks.getServerPort.mockReturnValue(3434)
    mocks.startChatServer.mockResolvedValue(4545)
    mocks.stopChatServer.mockResolvedValue(undefined)
  })

  it('reads settings with masked API keys and falls back when no database or invalid JSON exists', async () => {
    registerAIInlineHandlers()

    await expect(invoke(AIInlineChannels.invoke.GET_SETTINGS)).resolves.toEqual(
      expect.objectContaining({
        enabled: true,
        apiKey: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
      })
    )

    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('no vault')
    })
    await expect(invoke(AIInlineChannels.invoke.GET_SETTINGS)).resolves.toEqual(
      expect.objectContaining({ ...AI_INLINE_SETTINGS_DEFAULTS, apiKey: '' })
    )

    mocks.getSetting.mockReturnValueOnce('{bad json')
    await expect(invoke(AIInlineChannels.invoke.GET_SETTINGS)).resolves.toEqual(
      expect.objectContaining({ ...AI_INLINE_SETTINGS_DEFAULTS, apiKey: '' })
    )
  })

  it('persists settings, preserves masked keys, broadcasts updates, and reports no-vault failures', async () => {
    registerAIInlineHandlers()

    await expect(
      invoke(AIInlineChannels.invoke.SET_SETTINGS, {
        enabled: false,
        apiKey: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022',
        model: 'new-model'
      })
    ).resolves.toEqual({ success: true })

    const saved = JSON.parse(mocks.setSetting.mock.calls[0][2])
    expect(saved).toMatchObject({ enabled: false, apiKey: 'sk-real', model: 'new-model' })
    expect(mocks.webContents.send).toHaveBeenCalledWith(
      AIInlineChannels.events.SERVER_READY,
      expect.objectContaining({
        key: 'ai-inline',
        value: expect.objectContaining({
          apiKey: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
        })
      })
    )

    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    await expect(invoke(AIInlineChannels.invoke.SET_SETTINGS, { enabled: true })).resolves.toEqual({
      success: false,
      error: 'No vault is open. Please open a vault first.'
    })
  })

  it('starts, stops, and unregisters the chat server handlers', async () => {
    registerAIInlineHandlers()

    await expect(invoke(AIInlineChannels.invoke.GET_SERVER_PORT)).resolves.toBe(3434)
    await expect(invoke(AIInlineChannels.invoke.START_SERVER)).resolves.toEqual({
      success: true,
      port: 4545
    })
    expect(mocks.startChatServer).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, apiKey: 'sk-real' })
    )

    mocks.getSetting.mockReturnValueOnce(JSON.stringify({ enabled: false }))
    await expect(invoke(AIInlineChannels.invoke.START_SERVER)).resolves.toEqual({
      success: false,
      error: 'AI inline editing is disabled'
    })

    await expect(invoke(AIInlineChannels.invoke.STOP_SERVER)).resolves.toEqual({ success: true })
    expect(mocks.stopChatServer).toHaveBeenCalled()

    unregisterAIInlineHandlers()
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(AIInlineChannels.invoke.GET_SETTINGS)
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(AIInlineChannels.invoke.SET_SETTINGS)
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(
      AIInlineChannels.invoke.GET_SERVER_PORT
    )
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(AIInlineChannels.invoke.START_SERVER)
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(AIInlineChannels.invoke.STOP_SERVER)
    expect(mocks.info).toHaveBeenCalledWith('Unregistered')
  })

  it('lists installed Ollama models from the OpenAI-compatible endpoint', async () => {
    registerAIInlineHandlers()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gemma3:latest' }, { id: 'llama3.2' }, {}] })
    } as Response)

    await expect(invoke(AIInlineChannels.invoke.LIST_OLLAMA_MODELS)).resolves.toEqual({
      success: true,
      models: ['gemma3:latest', 'llama3.2']
    })
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:11434/v1/models')

    fetchSpy.mockResolvedValue({ ok: false, status: 500 } as Response)
    await expect(invoke(AIInlineChannels.invoke.LIST_OLLAMA_MODELS)).resolves.toEqual({
      success: false,
      error: 'Ollama responded 500'
    })
    fetchSpy.mockRestore()
  })
})

describe('Ollama listing telemetry: suppress "not running", report real faults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.getDatabase.mockReturnValue({ id: 'db' })
    mocks.getSetting.mockReturnValue(JSON.stringify({ enabled: true }))
  })

  it('suppresses connection-refused (Ollama not running) from error telemetry', async () => {
    // #given Ollama is simply not running — production logged 8x
    // "Failed_to_list_Ollama_models" for what is a normal state
    registerAIInlineHandlers()
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED'
      })
    })
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(refused)

    // #when the renderer asks for the model list
    const result = await invoke(AIInlineChannels.invoke.LIST_OLLAMA_MODELS)

    // #then the UI still learns it failed, it is marked as an expected condition,
    // and — asserted at the SINK — it never reaches error telemetry. Fails on
    // base (which does not mark ECONNREFUSED) and fails if either the marking or
    // the throttle-skip is reverted: the self-contained guard for this routing.
    expect(result).toEqual({ success: false, error: 'fetch failed' })
    expect(isExpectedConditionError(refused)).toBe(true)
    expect(mocks.trackMainError).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('still reports a genuine failure (DNS/ENOTFOUND) — suppression is not blanket', async () => {
    // #given a genuine fault (a real Ollama misconfiguration), not "not running"
    registerAIInlineHandlers()
    const dnsFailure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND ollama.local'), {
        code: 'ENOTFOUND'
      })
    })
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(dnsFailure)

    // #when the fetch fails for a reason other than connection-refused
    await invoke(AIInlineChannels.invoke.LIST_OLLAMA_MODELS)

    // #then it is not marked, and it reaches error telemetry — the integration
    // check that a real Ollama fault still reports. (The per-fix regression guard
    // for the throttle-masking bug is in validate.test.ts, and the errorCode
    // cause-walk is guarded in packages/contracts/telemetry-api.test.ts.)
    expect(isExpectedConditionError(dnsFailure)).toBe(false)
    expect(mocks.trackMainError).toHaveBeenCalledWith(
      'ipc',
      'errors:ai.listOllamaModelsFailed',
      dnsFailure
    )
    fetchSpy.mockRestore()
  })
})
