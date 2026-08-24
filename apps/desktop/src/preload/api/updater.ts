import {
  UpdaterChannels,
  type AppUpdateState,
  type WhatsNewPayload
} from '@memry/contracts/ipc-updater'
import { invoke, subscribe } from '../lib/ipc'

export const updaterApi = {
  getState: (): Promise<AppUpdateState> => invoke<AppUpdateState>(UpdaterChannels.invoke.GET_STATE),
  checkForUpdates: (): Promise<AppUpdateState> =>
    invoke<AppUpdateState>(UpdaterChannels.invoke.CHECK_FOR_UPDATES),
  downloadUpdate: (): Promise<AppUpdateState> =>
    invoke<AppUpdateState>(UpdaterChannels.invoke.DOWNLOAD_UPDATE),
  quitAndInstall: (): Promise<void> => invoke<void>(UpdaterChannels.invoke.QUIT_AND_INSTALL),
  setAutoCheck: (enabled: boolean): Promise<AppUpdateState> =>
    invoke<AppUpdateState>(UpdaterChannels.invoke.SET_AUTO_CHECK, enabled),
  consumeWhatsNew: (): Promise<WhatsNewPayload | null> =>
    invoke<WhatsNewPayload | null>(UpdaterChannels.invoke.CONSUME_WHATS_NEW)
}

export const updaterEvents = {
  onUpdaterStateChanged: (callback: (state: AppUpdateState) => void): (() => void) =>
    subscribe<AppUpdateState>(UpdaterChannels.events.STATE_CHANGED, callback)
}
