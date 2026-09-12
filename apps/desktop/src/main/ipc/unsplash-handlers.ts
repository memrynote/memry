import { ipcMain, net } from 'electron'

import { UnsplashChannels } from '@memry/contracts/ipc-channels'
import {
  UnsplashDownloadInputSchema,
  UnsplashSearchInputSchema
} from '@memry/contracts/unsplash-api'

import { createLogger } from '../lib/logger'
import { downloadPhoto, searchPhotos, type UnsplashDeps } from '../unsplash/service'

const logger = createLogger('IPC:Unsplash')

let registered = false

const UNSPLASH_CHANNELS = [
  UnsplashChannels.invoke.SEARCH,
  UnsplashChannels.invoke.DOWNLOAD
] as const

// `net.fetch` rather than global fetch: it honours the system proxy and the
// app's session, which is what every other outbound call in main uses.
const deps: UnsplashDeps = {
  fetch: (url, init) => net.fetch(url, init)
}

export const registerUnsplashHandlers = (): void => {
  if (registered) return

  ipcMain.handle(UnsplashChannels.invoke.SEARCH, async (_event, payload: unknown) => {
    const parsed = UnsplashSearchInputSchema.safeParse(payload)
    if (!parsed.success) {
      logger.warn('Rejected an Unsplash search with an invalid payload')
      return { ok: false as const, reason: 'failed' as const }
    }
    return searchPhotos(parsed.data, deps)
  })

  ipcMain.handle(UnsplashChannels.invoke.DOWNLOAD, async (_event, payload: unknown) => {
    const parsed = UnsplashDownloadInputSchema.safeParse(payload)
    if (!parsed.success) {
      logger.warn('Rejected an Unsplash download with an invalid payload')
      return { ok: false as const, reason: 'failed' as const }
    }
    return downloadPhoto(parsed.data, deps)
  })

  registered = true
}

export const unregisterUnsplashHandlers = (): void => {
  if (!registered) return
  for (const channel of UNSPLASH_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registered = false
}
