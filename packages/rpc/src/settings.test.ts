import { describe, expect, it } from 'vitest'
import { SettingsChannels } from '../../contracts/src/ipc-channels.ts'
import { settingsRpc } from './settings.ts'

describe('settingsRpc domain shape', () => {
  it('has name "settings"', () => {
    expect(settingsRpc.name).toBe('settings')
  })

  it('every method spec has channel, mode, and arg arrays', () => {
    for (const [key, method] of Object.entries(settingsRpc.methods)) {
      expect(method.channel, `method ${key}`).toBeTypeOf('string')
      expect(['invoke', 'sync'], `method ${key}`).toContain(method.mode)
      expect(Array.isArray(method.params)).toBe(true)
      expect(Array.isArray(method.invokeArgs)).toBe(true)
    }
  })

  it('method channels are unique', () => {
    const channels = Object.values(settingsRpc.methods).map((m) => m.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('wires get/set methods to SettingsChannels.invoke', () => {
    expect(settingsRpc.methods.get.channel).toBe(SettingsChannels.invoke.GET)
    expect(settingsRpc.methods.set.channel).toBe(SettingsChannels.invoke.SET)
    expect(settingsRpc.methods.set.invokeArgs).toEqual(['{ key, value }'])
  })

  it('registers getStartupThemeSync as a sync method with inline implementation', () => {
    const m = settingsRpc.methods.getStartupThemeSync
    expect(m.mode).toBe('sync')
    expect(m.channel).toBe(SettingsChannels.sync.GET_STARTUP_THEME)
    expect(m.implementation).toBeTypeOf('string')
    expect(m.implementation).toContain('invokeSync')
  })

  it('exposes the expected event channels', () => {
    expect(settingsRpc.events.onSettingsChanged.channel).toBe(SettingsChannels.events.CHANGED)
    expect(settingsRpc.events.onEmbeddingProgress.channel).toBe(
      SettingsChannels.events.EMBEDDING_PROGRESS
    )
    expect(settingsRpc.events.onVoiceModelProgress.channel).toBe(
      SettingsChannels.events.VOICE_MODEL_PROGRESS
    )
    expect(settingsRpc.events.onSettingsOpenRequested.channel).toBe(
      SettingsChannels.events.OPEN_SECTION
    )
  })

  it('section getters take no params', () => {
    expect(settingsRpc.methods.getGeneralSettings.params).toEqual([])
    expect(settingsRpc.methods.getAISettings.params).toEqual([])
    expect(settingsRpc.methods.getGraphSettings.params).toEqual([])
  })

  it('voice key setter wraps apiKey into an object', () => {
    expect(settingsRpc.methods.setVoiceTranscriptionOpenAIKey.invokeArgs).toEqual(['{ apiKey }'])
  })
})
