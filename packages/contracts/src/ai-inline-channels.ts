/**
 * AI Inline Editing IPC Channel Constants
 *
 * Defines channels for the local AI chat server used by BlockNote xl-ai.
 * No dependencies — safe for preload context.
 *
 * @module shared/ai-inline-channels
 */

export const AIInlineChannels = {
  invoke: {
    GET_SETTINGS: 'ai-inline:get-settings',
    SET_SETTINGS: 'ai-inline:set-settings',
    GET_SERVER_PORT: 'ai-inline:get-server-port',
    START_SERVER: 'ai-inline:start-server',
    STOP_SERVER: 'ai-inline:stop-server'
  },
  events: {
    SERVER_READY: 'ai-inline:server-ready',
    SERVER_ERROR: 'ai-inline:server-error'
  }
} as const

export type AIInlineInvokeChannel =
  (typeof AIInlineChannels.invoke)[keyof typeof AIInlineChannels.invoke]
export type AIInlineEventChannel =
  (typeof AIInlineChannels.events)[keyof typeof AIInlineChannels.events]

export interface AIInlineSettings {
  enabled: boolean
  provider: 'ollama' | 'openai' | 'anthropic'
  model: string
  apiKey: string
  baseUrl: string
}

export const AI_INLINE_SETTINGS_DEFAULTS: AIInlineSettings = {
  enabled: true,
  provider: 'ollama',
  model: 'llama3.2',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1'
}
