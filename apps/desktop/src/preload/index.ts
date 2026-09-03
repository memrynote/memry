import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  AppChannels,
  LocaleChannels,
  type AppNavigationCommandEvent,
  type AppMenuCommandEvent
} from '@memry/contracts/ipc-channels'
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'
import { createLogger } from './lib/logger'
import { invoke, invokeSync, send, subscribe } from './lib/ipc'
import { applyStartupTheme, getStartupThemeSync, THEME_STORAGE_KEY } from './lib/startup-theme'
import { applyZoomFactor, getStartupZoomFactor } from './lib/startup-zoom'
import { createGeneratedRpcApi } from './generated-rpc'
import { windowApi, getFileDropPaths, contextMenuApi, quickCaptureApi, flushApi } from './api/core'
import { vaultApi, vaultEvents } from './api/vault'
import { propertiesApi, templatesApi, savedFiltersApi, contentEvents } from './api/content'
import { journalApi, journalEvents } from './api/journal'
import { bookmarksApi, bookmarkEvents } from './api/bookmarks'
import { tagsApi, tagEvents } from './api/tags'
import { remindersApi, reminderEvents } from './api/reminders'
import { inboxEvents } from './api/inbox'
import { folderViewApi, folderViewEvents } from './api/folder-view'
import { recentsApi } from './api/recents'
import { searchApi, graphApi, searchEvents } from './api/search'
import { syncAuth, syncSetup, syncLinking, accountApi, syncDevices } from './api/sync-identity'
import {
  syncOps,
  cryptoApi,
  syncAttachments,
  syncCrdt,
  onCrdtStateChanged,
  onCrdtProviderReset,
  onCrdtProviderReady
} from './api/sync-ops'
import { syncEvents } from './api/sync-events'
import { updaterApi, updaterEvents } from './api/updater'
import { agentMcpApi } from './api/agent-mcp'
import { agentApi } from './api/agent'
import { importApi, importEvents } from './api/import'
import { homePagesApi, homePagesEvents } from './api/home-pages'
import { customIconsApi, customIconsEvents } from './api/custom-icons'

const logger = createLogger('Preload')
const MAIN_INVOKE_CHANNEL = 'main:invoke'
const MAIN_INVOKE_RESPONSE_CHANNEL_PREFIX = 'main:invoke:response:'

export interface MainInvokePayload {
  requestId: string
  channel: string
  payload?: unknown
}

if (typeof globalThis.window !== 'undefined') {
  const startupTheme = getStartupThemeSync()
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, startupTheme)
  } catch {
    // localStorage may be unavailable in some test or restricted environments
  }
  applyStartupTheme(startupTheme)

  // Applied here rather than from the renderer's settings load: without it
  // every launch paints at 100% and then visibly jumps to the user's zoom.
  // There is deliberately no synchronous-IPC fallback like the theme's — a
  // first launch with nothing cached is 100%, which is the right answer.
  applyZoomFactor(getStartupZoomFactor())
}

const generatedRpcApi = createGeneratedRpcApi({
  invoke,
  invokeSync,
  subscribe
})

const localeApi: LocaleApi = {
  get: () => invoke(LocaleChannels.Get),
  set: (locale: Locale) => invoke(LocaleChannels.Set, locale),
  list: () => invoke(LocaleChannels.List)
}

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
  recents: recentsApi,
  search: searchApi,
  quickCapture: quickCaptureApi,
  showContextMenu: contextMenuApi,
  tags: tagsApi,
  reminders: remindersApi,
  folderView: folderViewApi,
  locale: localeApi,

  ...vaultEvents,
  ...contentEvents,
  ...homePagesEvents,
  ...customIconsEvents,
  ...journalEvents,
  ...bookmarkEvents,
  ...searchEvents,
  ...tagEvents,
  ...reminderEvents,
  ...inboxEvents,
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
  updater: updaterApi,
  agentMcp: agentMcpApi,
  agent: agentApi,
  import: importApi,
  homePages: homePagesApi,
  customIcons: customIconsApi,

  onCrdtStateChanged,
  onCrdtProviderReset,
  onCrdtProviderReady,
  ...syncEvents,
  ...updaterEvents,
  ...importEvents,
  ...flushApi,

  onAppNavigationCommand: (callback: (command: AppNavigationCommandEvent) => void) =>
    subscribe<AppNavigationCommandEvent>(AppChannels.events.NAVIGATION_COMMAND, callback),
  onMenuCommand: (callback: (event: AppMenuCommandEvent) => void) =>
    subscribe<AppMenuCommandEvent>(AppChannels.events.MENU_COMMAND, callback),
  onLocaleChanged: (callback: (locale: Locale) => void) =>
    subscribe<Locale>(LocaleChannels.Changed, callback),
  onMainInvoke: (callback: (payload: MainInvokePayload) => void | Promise<void>) =>
    subscribe<MainInvokePayload>(MAIN_INVOKE_CHANNEL, (payload) => {
      void callback(payload)
    }),
  respondToMainInvoke: (requestId: string, response: unknown) =>
    send(`${MAIN_INVOKE_RESPONSE_CHANNEL_PREFIX}${requestId}`, response)
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
