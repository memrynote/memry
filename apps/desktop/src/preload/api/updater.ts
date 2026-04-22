import { UpdaterChannels, type AppUpdateState } from '@memry/contracts/ipc-updater'
import { invoke, subscribe } from '../lib/ipc'

export const updaterApi = {
  getState: (): Promise<AppUpdateState> => invoke<AppUpdateState>(UpdaterChannels.invoke.GET_STATE),
  checkForUpdates: (): Promise<AppUpdateState> =>
    invoke<AppUpdateState>(UpdaterChannels.invoke.CHECK_FOR_UPDATES),
  downloadUpdate: (): Promise<AppUpdateState> =>
    invoke<AppUpdateState>(UpdaterChannels.invoke.DOWNLOAD_UPDATE),
  quitAndInstall: (): Promise<void> => invoke<void>(UpdaterChannels.invoke.QUIT_AND_INSTALL)
}

export const updaterEvents = {
  onUpdaterStateChanged: (callback: (state: AppUpdateState) => void): (() => void) =>
    subscribe<AppUpdateState>(UpdaterChannels.events.STATE_CHANGED, callback)
}
