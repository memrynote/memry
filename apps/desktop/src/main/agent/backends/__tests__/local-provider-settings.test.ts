import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  hasApiKey: vi.fn(),
  setApiKey: vi.fn()
}))

vi.mock('../../../store', () => ({
  store: {
    get: mocks.storeGet,
    set: mocks.storeSet
  }
}))

vi.mock('../local-provider-keychain', () => ({
  hasLocalProviderApiKey: mocks.hasApiKey,
  setLocalProviderApiKey: mocks.setApiKey
}))

import {
  getLocalProviderSettings,
  isLoopbackBaseUrl,
  setLocalProviderSettings
} from '../local-provider-settings'

describe('local provider settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeGet.mockReturnValue({})
    mocks.hasApiKey.mockResolvedValue(false)
    mocks.setApiKey.mockResolvedValue(undefined)
  })

  it('defaults to the Ollama loopback preset', async () => {
    await expect(getLocalProviderSettings()).resolves.toEqual({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
      allowNonLoopback: false,
      thinking: 'default',
      apiKeyConfigured: false
    })
  })

  it('uses the selected preset defaults when no explicit endpoint is stored', async () => {
    mocks.storeGet.mockReturnValue({ localProvider: { preset: 'lm_studio' } })
    mocks.hasApiKey.mockResolvedValue(true)

    await expect(getLocalProviderSettings()).resolves.toEqual({
      preset: 'lm_studio',
      baseUrl: 'http://localhost:1234/v1',
      model: '',
      allowNonLoopback: false,
      thinking: 'default',
      apiKeyConfigured: true
    })
  })

  it('stores local settings and writes a provided API key to the keychain', async () => {
    mocks.storeGet.mockReturnValue({ disclosureAccepted: true })

    await setLocalProviderSettings({
      preset: 'custom',
      baseUrl: 'https://llm.example.com/v1',
      model: 'custom-model',
      allowNonLoopback: true,
      apiKey: 'secret'
    })

    expect(mocks.storeSet).toHaveBeenCalledWith('agent', {
      disclosureAccepted: true,
      localProvider: {
        preset: 'custom',
        baseUrl: 'https://llm.example.com/v1',
        model: 'custom-model',
        allowNonLoopback: true
      }
    })
    expect(mocks.setApiKey).toHaveBeenCalledWith('secret')
  })

  it('stores Thinking Off and keeps it when an update leaves thinking out', async () => {
    const base = {
      preset: 'custom' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'any-model-name',
      allowNonLoopback: true
    }
    await setLocalProviderSettings({ ...base, thinking: 'off' })
    expect(mocks.storeSet).toHaveBeenLastCalledWith('agent', {
      localProvider: { ...base, thinking: 'off' }
    })

    mocks.storeGet.mockReturnValue({ localProvider: { ...base, thinking: 'off' } })
    await setLocalProviderSettings({ ...base, model: 'other-model' })
    expect(mocks.storeSet).toHaveBeenLastCalledWith('agent', {
      localProvider: { ...base, model: 'other-model', thinking: 'off' }
    })
    await expect(getLocalProviderSettings()).resolves.toMatchObject({ thinking: 'off' })
  })

  it('rejects non-loopback endpoints without explicit confirmation', async () => {
    await expect(
      setLocalProviderSettings({
        preset: 'custom',
        baseUrl: 'https://llm.example.com/v1',
        model: 'custom-model',
        allowNonLoopback: false
      })
    ).rejects.toThrow(/Non-loopback/)

    expect(mocks.storeSet).not.toHaveBeenCalled()
    expect(mocks.setApiKey).not.toHaveBeenCalled()
  })

  it('clears the keychain value when requested', async () => {
    await setLocalProviderSettings({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      allowNonLoopback: false,
      clearApiKey: true
    })

    expect(mocks.setApiKey).toHaveBeenCalledWith(null)
  })

  it('classifies loopback endpoints conservatively', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:8080/v1')).toBe(true)
    expect(isLoopbackBaseUrl('https://llm.example.com/v1')).toBe(false)
    expect(isLoopbackBaseUrl('not a url')).toBe(false)
  })
})
