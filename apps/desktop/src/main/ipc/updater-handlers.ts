import { ipcMain } from 'electron'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import {
  checkForUpdates,
  consumeWhatsNew,
  downloadUpdate,
  getUpdateState,
  quitAndInstall,
  setAutoCheckEnabled
} from '../updater'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(UpdaterChannels.invoke.GET_STATE, () => getUpdateState())
  ipcMain.handle(UpdaterChannels.invoke.CHECK_FOR_UPDATES, () => checkForUpdates())
  ipcMain.handle(UpdaterChannels.invoke.DOWNLOAD_UPDATE, () => downloadUpdate())
  ipcMain.handle(UpdaterChannels.invoke.QUIT_AND_INSTALL, () => {
    quitAndInstall()
  })
  ipcMain.handle(UpdaterChannels.invoke.SET_AUTO_CHECK, (_event, enabled: boolean) =>
    setAutoCheckEnabled(enabled)
  )
  ipcMain.handle(UpdaterChannels.invoke.CONSUME_WHATS_NEW, () => consumeWhatsNew())
}

export function unregisterUpdaterHandlers(): void {
  ipcMain.removeHandler(UpdaterChannels.invoke.GET_STATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.CHECK_FOR_UPDATES)
  ipcMain.removeHandler(UpdaterChannels.invoke.DOWNLOAD_UPDATE)
  ipcMain.removeHandler(UpdaterChannels.invoke.QUIT_AND_INSTALL)
  ipcMain.removeHandler(UpdaterChannels.invoke.SET_AUTO_CHECK)
  ipcMain.removeHandler(UpdaterChannels.invoke.CONSUME_WHATS_NEW)
}
