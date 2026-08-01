import { FolderViewChannels } from '@memry/contracts/ipc-channels'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { invoke, subscribe } from '../lib/ipc'
import type { MainIpcInvokeArgs } from '../../main/ipc/generated-ipc-invoke-map'

export const folderViewApi = {
  getConfig: (folderPath: string) => invoke(FolderViewChannels.invoke.GET_CONFIG, { folderPath }),
  setConfig: (folderPath: string, config: Record<string, unknown>) =>
    invoke(FolderViewChannels.invoke.SET_CONFIG, { folderPath, config }),
  getViews: (scope: ViewScope) => invoke(FolderViewChannels.invoke.GET_VIEWS, { scope }),
  setView: (scope: ViewScope, view: Record<string, unknown>) =>
    invoke(FolderViewChannels.invoke.SET_VIEW, { scope, view } as MainIpcInvokeArgs<
      typeof FolderViewChannels.invoke.SET_VIEW
    >[0]),
  deleteView: (scope: ViewScope, viewName: string) =>
    invoke(FolderViewChannels.invoke.DELETE_VIEW, { scope, viewName }),
  listWithProperties: (options: {
    scope: ViewScope
    properties?: string[]
    limit?: number
    offset?: number
  }) => invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, options),
  getAvailableProperties: (scope: ViewScope) =>
    invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, { scope }),
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
