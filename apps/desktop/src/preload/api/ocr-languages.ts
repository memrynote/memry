import { OcrLanguagesChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type { OcrLanguagesSetInput, OcrLanguagesState } from '@memry/contracts/ocr-languages-api'

export const ocrLanguagesApi = {
  get: (): Promise<OcrLanguagesState> => invoke(OcrLanguagesChannels.invoke.GET),
  set: (input: OcrLanguagesSetInput): Promise<OcrLanguagesState> =>
    invoke(OcrLanguagesChannels.invoke.SET, input),
  retry: (): Promise<OcrLanguagesState> => invoke(OcrLanguagesChannels.invoke.RETRY)
}

export const ocrLanguagesEvents = {
  onOcrLanguagesChanged: (callback: (state: OcrLanguagesState) => void): (() => void) =>
    subscribe<OcrLanguagesState>(OcrLanguagesChannels.events.CHANGED, callback)
}
