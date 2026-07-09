import { ipcMain } from 'electron'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstall,
  setAutoCheckEnabled,
  setAutoDownloadEnabled,
  skipVersion
} from '../updater'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(UpdaterChannels.invoke.GET_STATE, () => getUpdateState())
  // Manual checks clear a skipped version so the user can see it again.
  ipcMain.handle(UpdaterChannels.invoke.CHECK_FOR_UPDATES, () =>
    checkForUpdates({ clearSkip: true })
  )
  ipcMain.handle(UpdaterChannels.invoke.DOWNLOAD_UPDATE, () => downloadUpdate())
  ipcMain.handle(UpdaterChannels.invoke.QUIT_AND_INSTALL, () => {
    quitAndInstall()
  })
  ipcMain.handle(UpdaterChannels.invoke.SKIP_VERSION, (_event, version: string) =>
    skipVersion(version)
  )
  ipcMain.handle(UpdaterChannels.invoke.SET_AUTO_DOWNLOAD, (_event, enabled: boolean) =>
    setAutoDownloadEnabled(enabled)
  )
  ipcMain.handle(UpdaterChannels.invoke.SET_AUTO_CHECK, (_event, enabled: boolean) =>
    setAutoCheckEnabled(enabled)
  )
}

export function unregisterUpdaterHandlers(): void {
  ipcMain.removeHandler(UpdaterChannels.invoke.GET_STATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.CHECK_FOR_UPDATES)
  ipcMain.removeHandler(UpdaterChannels.invoke.DOWNLOAD_UPDATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.QUIT_AND_INSTALL)
  ipcMain.removeHandler(UpdaterChannels.invoke.SKIP_VERSION)
  ipcMain.removeHandler(UpdaterChannels.invoke.SET_AUTO_DOWNLOAD)
  ipcMain.removeHandler(UpdaterChannels.invoke.SET_AUTO_CHECK)
}
