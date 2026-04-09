import { ipcMain, BrowserWindow } from 'electron'
import { AIInlineChannels, AI_INLINE_SETTINGS_DEFAULTS } from '@memry/contracts/ai-inline-channels'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'

import { startChatServer, stopChatServer, getServerPort } from '../ai-inline/ai-chat-server'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getSetting, setSetting } from '../settings/settings-store'
import { withErrorHandler } from './validate'

const logger = createLogger('IPC:AIInline')

const SETTINGS_KEY = 'ai-inline'
const MASKED_KEY = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

function getDbOrNull() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

function readSettings(): AIInlineSettings {
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
    return maskApiKey(readSettings())
  })

  ipcMain.handle(
    AIInlineChannels.invoke.SET_SETTINGS,
    (_event, updates: Partial<AIInlineSettings>) => {
      const db = getDbOrNull()
      if (!db) return { success: false, error: 'No vault open' }

      const current = readSettings()

      if (updates.apiKey === MASKED_KEY) {
        delete updates.apiKey
      }

      const updated = { ...current, ...updates }
      setSetting(db, SETTINGS_KEY, JSON.stringify(updated))

      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(AIInlineChannels.events.SERVER_READY, {
          key: SETTINGS_KEY,
          value: maskApiKey(updated)
        })
      })

      return { success: true }
    }
  )

  ipcMain.handle(AIInlineChannels.invoke.GET_SERVER_PORT, () => {
    return getServerPort()
  })

  ipcMain.handle(
    AIInlineChannels.invoke.START_SERVER,
    withErrorHandler(async () => {
      const settings = readSettings()
      if (!settings.enabled) {
        return { success: false, error: 'AI inline editing is disabled' }
      }
      const port = await startChatServer(settings)
      return { success: true, port }
    }, 'Unknown error')
  )

  ipcMain.handle(AIInlineChannels.invoke.STOP_SERVER, async () => {
    await stopChatServer()
    return { success: true }
  })

  logger.info('Registered')
}

export function unregisterAIInlineHandlers(): void {
  ipcMain.removeHandler(AIInlineChannels.invoke.GET_SETTINGS)
  ipcMain.removeHandler(AIInlineChannels.invoke.SET_SETTINGS)
  ipcMain.removeHandler(AIInlineChannels.invoke.GET_SERVER_PORT)
  ipcMain.removeHandler(AIInlineChannels.invoke.START_SERVER)
  ipcMain.removeHandler(AIInlineChannels.invoke.STOP_SERVER)
  logger.info('Unregistered')
}
