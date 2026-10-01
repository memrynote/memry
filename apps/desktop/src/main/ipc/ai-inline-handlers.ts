import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { AIInlineChannels, AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'

import type * as AIChatServer from '../ai-inline/ai-chat-server'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getSetting, setSetting } from '../settings/settings-store'
import { isConnectionRefusedError, markExpectedCondition } from '../telemetry/expected-conditions'
import { withErrorHandler } from './validate'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('IPC:AIInline')

const SETTINGS_KEY = 'ai-inline'
const MASKED_KEY = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

let chatServerLoad: Promise<typeof AIChatServer> | null = null
let chatServer: typeof AIChatServer | null = null

// Lazy on purpose: ai-chat-server imports `ai`, `@blocknote/xl-ai/server` and
// the @ai-sdk providers, which stay out of the main process until the user
// actually starts inline AI. See scripts/check-main-startup-set.mjs.
function loadChatServer(): Promise<typeof AIChatServer> {
  if (!chatServerLoad) {
    chatServerLoad = import('../ai-inline/ai-chat-server').then(
      (loaded) => {
        chatServer = loaded
        return loaded
      },
      (error: unknown) => {
        chatServerLoad = null
        throw error
      }
    )
  }
  return chatServerLoad
}

/**
 * Stop the inline AI chat server if this session ever loaded it. A server can
 * only be running once its module has loaded, so an unloaded module means
 * there is nothing to stop and nothing to import on the way out.
 */
export async function stopChatServerIfLoaded(): Promise<void> {
  if (!chatServerLoad) return
  const loaded = await chatServerLoad.catch(() => null)
  await loaded?.stopChatServer()
}

function getDbOrNull() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

/** The stored inline-AI settings, API key included. Main-process only. */
export function readAIInlineSettings(): AIInlineSettings {
  const db = getDbOrNull()
  if (!db) return { ...AI_INLINE_SETTINGS_DEFAULTS }

  const raw = getSetting(db, SETTINGS_KEY)
  if (!raw) return { ...AI_INLINE_SETTINGS_DEFAULTS }

  try {
    const parsed = JSON.parse(raw) as Partial<AIInlineSettings>
    return { ...AI_INLINE_SETTINGS_DEFAULTS, ...parsed }
  } catch {
    return { ...AI_INLINE_SETTINGS_DEFAULTS }
  }
}

function maskApiKey(settings: AIInlineSettings): AIInlineSettings {
  return { ...settings, apiKey: settings.apiKey ? MASKED_KEY : '' }
}

export function registerAIInlineHandlers(): void {
  ipcMain.handle(AIInlineChannels.invoke.GET_SETTINGS, () => {
    return maskApiKey(readAIInlineSettings())
  })

  ipcMain.handle(
    AIInlineChannels.invoke.SET_SETTINGS,
    (_event, updates: Partial<AIInlineSettings>) => {
      const db = getDbOrNull()
      if (!db) return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }

      const current = readAIInlineSettings()

      if (updates.apiKey === MASKED_KEY) {
        delete updates.apiKey
      }

      const updated = { ...current, ...updates }
      setSetting(db, SETTINGS_KEY, JSON.stringify(updated))

      broadcastToAllWindows(AIInlineChannels.events.SERVER_READY, {
        key: SETTINGS_KEY,
        value: maskApiKey(updated)
      })

      return { success: true }
    }
  )

  // Answered without loading the server: an unloaded module has no server.
  ipcMain.handle(AIInlineChannels.invoke.GET_SERVER_PORT, () => {
    return chatServer?.getServerPort() ?? null
  })

  ipcMain.handle(
    AIInlineChannels.invoke.START_SERVER,
    withErrorHandler(async () => {
      const settings = readAIInlineSettings()
      if (!settings.enabled) {
        return { success: false, error: getMainI18n().t('errors:ai.inlineDisabled') }
      }
      const { startChatServer } = await loadChatServer()
      const port = await startChatServer(settings)
      return { success: true, port }
    }, 'errors:generic.unknown')
  )

  ipcMain.handle(AIInlineChannels.invoke.STOP_SERVER, async () => {
    await stopChatServerIfLoaded()
    return { success: true }
  })

  ipcMain.handle(
    AIInlineChannels.invoke.LIST_OLLAMA_MODELS,
    withErrorHandler(async () => {
      const { baseUrl } = readAIInlineSettings()
      const url = `${(baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '')}/models`
      let res: Response
      try {
        res = await fetch(url)
      } catch (error) {
        // Nothing listening on the port = Ollama is simply not running. That is
        // a normal state, not a fault: the UI still shows the failure, but it
        // must not be reported as an error. Any other failure (DNS, reset, a
        // bad status below) is a real misconfiguration and still reports.
        if (isConnectionRefusedError(error)) markExpectedCondition(error)
        throw error
      }
      if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      const models = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
      return { success: true, models }
    }, 'errors:ai.listOllamaModelsFailed')
  )
}

export function unregisterAIInlineHandlers(): void {
  ipcMain.removeHandler(AIInlineChannels.invoke.GET_SETTINGS)
  ipcMain.removeHandler(AIInlineChannels.invoke.SET_SETTINGS)
  ipcMain.removeHandler(AIInlineChannels.invoke.GET_SERVER_PORT)
  ipcMain.removeHandler(AIInlineChannels.invoke.START_SERVER)
  ipcMain.removeHandler(AIInlineChannels.invoke.STOP_SERVER)
  ipcMain.removeHandler(AIInlineChannels.invoke.LIST_OLLAMA_MODELS)
  logger.info('Unregistered')
}
