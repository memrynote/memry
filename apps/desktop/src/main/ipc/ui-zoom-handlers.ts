import { ipcMain } from 'electron'
import { clampZoomFactor, UiZoomChannels, type ZoomFactor } from '@memry/contracts/ui-zoom'
import { getZoomFactor, setZoomFactor } from '../window-zoom'

export function registerUiZoomHandlers(): void {
  ipcMain.handle(UiZoomChannels.invoke.GET, (): ZoomFactor => getZoomFactor())
  ipcMain.handle(UiZoomChannels.invoke.SET, (_event, factor: unknown): ZoomFactor =>
    setZoomFactor(clampZoomFactor(factor))
  )
}

export function unregisterUiZoomHandlers(): void {
  ipcMain.removeHandler(UiZoomChannels.invoke.GET)
  ipcMain.removeHandler(UiZoomChannels.invoke.SET)
}
