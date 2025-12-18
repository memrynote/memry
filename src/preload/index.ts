import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Vault IPC channel names (mirrored from contracts to avoid import issues in preload)
const VaultChannels = {
  invoke: {
    SELECT: 'vault:select',
    CREATE: 'vault:create',
    GET_ALL: 'vault:get-all',
    GET_STATUS: 'vault:get-status',
    GET_CONFIG: 'vault:get-config',
    UPDATE_CONFIG: 'vault:update-config',
    CLOSE: 'vault:close',
    SWITCH: 'vault:switch',
    REMOVE: 'vault:remove',
    REINDEX: 'vault:reindex'
  },
  events: {
    STATUS_CHANGED: 'vault:status-changed',
    INDEX_PROGRESS: 'vault:index-progress',
    ERROR: 'vault:error'
  }
} as const

// Notes IPC channel names (mirrored from contracts to avoid import issues in preload)
const NotesChannels = {
  invoke: {
    CREATE: 'notes:create',
    GET: 'notes:get',
    GET_BY_PATH: 'notes:get-by-path',
    UPDATE: 'notes:update',
    RENAME: 'notes:rename',
    MOVE: 'notes:move',
    DELETE: 'notes:delete',
    LIST: 'notes:list',
    GET_TAGS: 'notes:get-tags',
    GET_LINKS: 'notes:get-links',
    GET_FOLDERS: 'notes:get-folders',
    CREATE_FOLDER: 'notes:create-folder',
    EXISTS: 'notes:exists',
    OPEN_EXTERNAL: 'notes:open-external',
    REVEAL_IN_FINDER: 'notes:reveal-in-finder'
  },
  events: {
    CREATED: 'notes:created',
    UPDATED: 'notes:updated',
    DELETED: 'notes:deleted',
    RENAMED: 'notes:renamed',
    MOVED: 'notes:moved',
    EXTERNAL_CHANGE: 'notes:external-change'
  }
} as const

// Custom APIs for renderer
const api = {
  // Window controls for custom traffic lights
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),

  // Vault API
  vault: {
    select: (path?: string) => ipcRenderer.invoke(VaultChannels.invoke.SELECT, { path }),
    create: (path: string, name: string) =>
      ipcRenderer.invoke(VaultChannels.invoke.CREATE, { path, name }),
    getAll: () => ipcRenderer.invoke(VaultChannels.invoke.GET_ALL),
    getStatus: () => ipcRenderer.invoke(VaultChannels.invoke.GET_STATUS),
    getConfig: () => ipcRenderer.invoke(VaultChannels.invoke.GET_CONFIG),
    updateConfig: (config: Record<string, unknown>) =>
      ipcRenderer.invoke(VaultChannels.invoke.UPDATE_CONFIG, config),
    close: () => ipcRenderer.invoke(VaultChannels.invoke.CLOSE),
    switch: (vaultPath: string) => ipcRenderer.invoke(VaultChannels.invoke.SWITCH, vaultPath),
    remove: (vaultPath: string) => ipcRenderer.invoke(VaultChannels.invoke.REMOVE, vaultPath),
    reindex: () => ipcRenderer.invoke(VaultChannels.invoke.REINDEX)
  },

  // Notes API
  notes: {
    create: (input: { title: string; content?: string; folder?: string; tags?: string[] }) =>
      ipcRenderer.invoke(NotesChannels.invoke.CREATE, input),
    get: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.GET, id),
    getByPath: (path: string) => ipcRenderer.invoke(NotesChannels.invoke.GET_BY_PATH, path),
    update: (input: {
      id: string
      title?: string
      content?: string
      tags?: string[]
      frontmatter?: Record<string, unknown>
    }) => ipcRenderer.invoke(NotesChannels.invoke.UPDATE, input),
    rename: (id: string, newTitle: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.RENAME, { id, newTitle }),
    move: (id: string, newFolder: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.MOVE, { id, newFolder }),
    delete: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.DELETE, id),
    list: (options?: {
      folder?: string
      tags?: string[]
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(NotesChannels.invoke.LIST, options ?? {}),
    getTags: () => ipcRenderer.invoke(NotesChannels.invoke.GET_TAGS),
    getLinks: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.GET_LINKS, id),
    getFolders: () => ipcRenderer.invoke(NotesChannels.invoke.GET_FOLDERS),
    createFolder: (path: string) => ipcRenderer.invoke(NotesChannels.invoke.CREATE_FOLDER, path),
    exists: (titleOrPath: string) => ipcRenderer.invoke(NotesChannels.invoke.EXISTS, titleOrPath),
    openExternal: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.OPEN_EXTERNAL, id),
    revealInFinder: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.REVEAL_IN_FINDER, id)
  },

  // Event subscription helpers
  onVaultStatusChanged: (callback: (status: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => callback(status)
    ipcRenderer.on(VaultChannels.events.STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.STATUS_CHANGED, handler)
  },

  onVaultIndexProgress: (callback: (progress: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: number): void =>
      callback(progress)
    ipcRenderer.on(VaultChannels.events.INDEX_PROGRESS, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.INDEX_PROGRESS, handler)
  },

  onVaultError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on(VaultChannels.events.ERROR, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.ERROR, handler)
  },

  // Notes event subscription helpers
  onNoteCreated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.CREATED, handler)
  },

  onNoteUpdated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.UPDATED, handler)
  },

  onNoteDeleted: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.DELETED, handler)
  },

  onNoteRenamed: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.RENAMED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.RENAMED, handler)
  },

  onNoteMoved: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.MOVED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.MOVED, handler)
  },

  onNoteExternalChange: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.EXTERNAL_CHANGE, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.EXTERNAL_CHANGE, handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
