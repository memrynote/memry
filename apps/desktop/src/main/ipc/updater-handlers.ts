import { ipcMain } from 'electron'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { checkForUpdates, downloadUpdate, getUpdateState, quitAndInstall } from '../updater'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(UpdaterChannels.invoke.GET_STATE, () => getUpdateState())
  ipcMain.handle(UpdaterChannels.invoke.CHECK_FOR_UPDATES, () => checkForUpdates())
  ipcMain.handle(UpdaterChannels.invoke.DOWNLOAD_UPDATE, () => downloadUpdate())
  ipcMain.handle(UpdaterChannels.invoke.QUIT_AND_INSTALL, () => {
    quitAndInstall()
  })
}

export function unregisterUpdaterHandlers(): void {
  ipcMain.removeHandler(UpdaterChannels.invoke.GET_STATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.CHECK_FOR_UPDATES)
  ipcMain.removeHandler(UpdaterChannels.invoke.DOWNLOAD_UPDATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.QUIT_AND_INSTALL)
}
