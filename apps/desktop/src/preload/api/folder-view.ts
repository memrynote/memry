import { FolderViewChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type { MainIpcInvokeArgs } from '../../main/ipc/generated-ipc-invoke-map'

export const folderViewApi = {
  getConfig: (folderPath: string) => invoke(FolderViewChannels.invoke.GET_CONFIG, { folderPath }),
  setConfig: (folderPath: string, config: Record<string, unknown>) =>
    invoke(FolderViewChannels.invoke.SET_CONFIG, { folderPath, config }),
  getViews: (folderPath: string) => invoke(FolderViewChannels.invoke.GET_VIEWS, { folderPath }),
  setView: (folderPath: string, view: Record<string, unknown>) =>
    invoke(FolderViewChannels.invoke.SET_VIEW, { folderPath, view } as MainIpcInvokeArgs<
      typeof FolderViewChannels.invoke.SET_VIEW
    >[0]),
  deleteView: (folderPath: string, viewName: string) =>
    invoke(FolderViewChannels.invoke.DELETE_VIEW, { folderPath, viewName }),
  listWithProperties: (options: {
    folderPath: string
    properties?: string[]
    limit?: number
    offset?: number
  }) => invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, options),
  getAvailableProperties: (folderPath: string) =>
    invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, { folderPath }),
  getFolderSuggestions: (noteId: string) =>
    invoke(FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS, { noteId }),
  folderExists: (folderPath: string): Promise<boolean> =>
    invoke<boolean>(FolderViewChannels.invoke.FOLDER_EXISTS, folderPath)
}

export const folderViewEvents = {
  onFolderViewConfigUpdated: (
    callback: (event: { path: string; source: 'internal' | 'external' }) => void
  ): (() => void) =>
    subscribe<{ path: string; source: 'internal' | 'external' }>(
      FolderViewChannels.events.CONFIG_UPDATED,
      callback
    )
}
