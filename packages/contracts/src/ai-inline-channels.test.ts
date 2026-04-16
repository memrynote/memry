/**
 * AI Inline Channels Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  AIInlineChannels,
  AI_INLINE_SETTINGS_DEFAULTS,
  type AIInlineInvokeChannel,
  type AIInlineEventChannel,
  type AIInlineSettings
} from './ai-inline-channels'

describe('AIInlineChannels.invoke', () => {
  it('exposes the expected invoke channels', () => {
    expect(AIInlineChannels.invoke).toEqual({
      GET_SETTINGS: 'ai-inline:get-settings',
      SET_SETTINGS: 'ai-inline:set-settings',
      GET_SERVER_PORT: 'ai-inline:get-server-port',
      START_SERVER: 'ai-inline:start-server',
      STOP_SERVER: 'ai-inline:stop-server'
    })
  })

  it('all invoke channel ids share the ai-inline: prefix', () => {
    for (const channel of Object.values(AIInlineChannels.invoke)) {
      expect(channel.startsWith('ai-inline:')).toBe(true)
    }
  })

  it('type-checks every invoke channel', () => {
    const channels: AIInlineInvokeChannel[] = [
      AIInlineChannels.invoke.GET_SETTINGS,
      AIInlineChannels.invoke.SET_SETTINGS,
      AIInlineChannels.invoke.GET_SERVER_PORT,
      AIInlineChannels.invoke.START_SERVER,
      AIInlineChannels.invoke.STOP_SERVER
    ]
    expect(channels).toHaveLength(5)
  })
})

describe('AIInlineChannels.events', () => {
  it('exposes the expected event channels', () => {
    expect(AIInlineChannels.events).toEqual({
      SERVER_READY: 'ai-inline:server-ready',
      SERVER_ERROR: 'ai-inline:server-error'
    })
  })

  it('type-checks every event channel', () => {
    const events: AIInlineEventChannel[] = [
      AIInlineChannels.events.SERVER_READY,
      AIInlineChannels.events.SERVER_ERROR
    ]
    expect(events).toHaveLength(2)
  })
})

describe('AI_INLINE_SETTINGS_DEFAULTS', () => {
  it('matches the expected defaults', () => {
    expect(AI_INLINE_SETTINGS_DEFAULTS).toEqual({
      enabled: true,
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1'
    })
  })

  it('conforms to AIInlineSettings type', () => {
    const settings: AIInlineSettings = AI_INLINE_SETTINGS_DEFAULTS
    expect(settings.provider).toBe('ollama')
    expect(typeof settings.enabled).toBe('boolean')
    expect(typeof settings.model).toBe('string')
    expect(typeof settings.apiKey).toBe('string')
    expect(typeof settings.baseUrl).toBe('string')
  })

  it('allows all supported providers', () => {
    const providers: AIInlineSettings['provider'][] = ['ollama', 'openai', 'anthropic']
    for (const provider of providers) {
      const settings: AIInlineSettings = { ...AI_INLINE_SETTINGS_DEFAULTS, provider }
      expect(settings.provider).toBe(provider)
    }
  })
})
