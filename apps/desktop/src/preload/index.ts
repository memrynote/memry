import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { createLogger } from './lib/logger'
import { invoke, invokeSync, subscribe } from './lib/ipc'
import { applyStartupTheme, getStartupThemeSync, THEME_STORAGE_KEY } from './lib/startup-theme'
import { createGeneratedRpcApi } from './generated-rpc'
import { windowApi, getFileDropPaths, contextMenuApi, quickCaptureApi, flushApi } from './api/core'
import { vaultApi, vaultEvents } from './api/vault'
import { propertiesApi, templatesApi, savedFiltersApi, contentEvents } from './api/content'
import { journalApi, journalEvents } from './api/journal'
import { bookmarksApi, bookmarkEvents } from './api/bookmarks'
import { tagsApi, tagEvents } from './api/tags'
import { remindersApi, reminderEvents } from './api/reminders'
import { folderViewApi, folderViewEvents } from './api/folder-view'
import { searchApi, graphApi, searchEvents } from './api/search'
import { syncAuth, syncSetup, syncLinking, accountApi, syncDevices } from './api/sync-identity'
import { syncOps, cryptoApi, syncAttachments, syncCrdt, onCrdtStateChanged } from './api/sync-ops'
import { syncEvents } from './api/sync-events'

const logger = createLogger('Preload')

if (typeof globalThis.window !== 'undefined') {
  const startupTheme = getStartupThemeSync()
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, startupTheme)
  } catch {
    // localStorage may be unavailable in some test or restricted environments
  }
  applyStartupTheme(startupTheme)
}

const generatedRpcApi = createGeneratedRpcApi({
  invoke,
  invokeSync,
  subscribe
})

export const api = {
  ...windowApi,
  getFileDropPaths,

  ...generatedRpcApi,
  settings: {
    ...generatedRpcApi.settings,
    getStartupThemeSync
  },

  vault: vaultApi,
  properties: propertiesApi,
  templates: templatesApi,
  savedFilters: savedFiltersApi,
  journal: journalApi,
  bookmarks: bookmarksApi,
  graph: graphApi,
  search: searchApi,
  quickCapture: quickCaptureApi,
  showContextMenu: contextMenuApi,
  tags: tagsApi,
  reminders: remindersApi,
  folderView: folderViewApi,

  ...vaultEvents,
  ...contentEvents,
  ...journalEvents,
  ...bookmarkEvents,
  ...searchEvents,
  ...tagEvents,
  ...reminderEvents,
  ...folderViewEvents,

  syncAuth,
  syncSetup,
  syncLinking,
  account: accountApi,
  syncDevices,
  syncOps,
  crypto: cryptoApi,
  syncAttachments,
  syncCrdt,

  onCrdtStateChanged,
  ...syncEvents,
  ...flushApi
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    logger.error('contextBridge exposure failed', error)
  }
} else {
  ;(window as unknown as Record<string, unknown>).electron = electronAPI
  ;(window as unknown as Record<string, unknown>).api = api
}

export type API = typeof api
