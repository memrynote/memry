import type { MockRouteMap } from './types'

/**
 * AI Inline mock routes. Consumed by use-ai-inline hook + the AI Inline
 * settings page. M1 returns defaults so the page mounts; no real AI gateway
 * is started. M8.12 lands real backend.
 */

const DEFAULT_SETTINGS = {
  enabled: false,
  provider: 'ollama' as const,
  model: 'llama3.2',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1'
}

let settings = { ...DEFAULT_SETTINGS }

export const aiInlineRoutes: MockRouteMap = {
  ai_inline_get_settings: async () => settings,
  ai_inline_set_settings: async (args) => {
    const patch = (args ?? {}) as Partial<typeof DEFAULT_SETTINGS>
    settings = { ...settings, ...patch }
    return { success: true }
  },
  ai_inline_get_server_port: async () => 0,
  ai_inline_start_server: async () => ({ ok: false, port: 0 }),
  ai_inline_stop_server: async () => ({ ok: true })
}
