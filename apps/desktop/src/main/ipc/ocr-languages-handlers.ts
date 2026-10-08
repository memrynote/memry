import { ipcMain } from 'electron'
import { OcrLanguagesChannels, OcrLanguagesSetSchema } from '@memry/contracts/ocr-languages-api'
import {
  getOcrLanguagesState,
  retryOcrLanguages,
  setOcrLanguages
} from '../file-text/ocr-languages'
import { createValidatedHandler } from './validate'

export function registerOcrLanguagesHandlers(): void {
  ipcMain.handle(OcrLanguagesChannels.invoke.GET, () => getOcrLanguagesState())
  ipcMain.handle(
    OcrLanguagesChannels.invoke.SET,
    createValidatedHandler(OcrLanguagesSetSchema, (input) => setOcrLanguages(input.languages))
  )
  ipcMain.handle(OcrLanguagesChannels.invoke.RETRY, () => retryOcrLanguages())
}

export function unregisterOcrLanguagesHandlers(): void {
  ipcMain.removeHandler(OcrLanguagesChannels.invoke.GET)
  ipcMain.removeHandler(OcrLanguagesChannels.invoke.SET)
  ipcMain.removeHandler(OcrLanguagesChannels.invoke.RETRY)
}
