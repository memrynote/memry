import { ipcMain } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import {
  getAIModelStatus,
  getAISettings,
  loadAIModel,
  reindexEmbeddings,
  writeAISettings,
  type AISettings
} from '../settings/ai-settings'
import { withErrorHandler } from './validate'

export function registerSettingsAIHandlers(): void {
  ipcMain.handle(SettingsChannels.invoke.GET_AI_SETTINGS, () => getAISettings())
  ipcMain.handle(SettingsChannels.invoke.SET_AI_SETTINGS, (_event, settings: Partial<AISettings>) =>
    writeAISettings(settings)
  )
  ipcMain.handle(SettingsChannels.invoke.GET_AI_MODEL_STATUS, () => getAIModelStatus())
  ipcMain.handle(
    SettingsChannels.invoke.LOAD_AI_MODEL,
    withErrorHandler(loadAIModel, 'errors:generic.unknown')
  )
  ipcMain.handle(
    SettingsChannels.invoke.REINDEX_EMBEDDINGS,
    withErrorHandler(reindexEmbeddings, 'errors:generic.unknown')
  )
}

export function unregisterSettingsAIHandlers(): void {
  ipcMain.removeHandler(SettingsChannels.invoke.GET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_AI_MODEL_STATUS)
  ipcMain.removeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
  ipcMain.removeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)
}
