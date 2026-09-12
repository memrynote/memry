import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockApp, mockElectron } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockElectron.ipcMain,
  net: { fetch: vi.fn() }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const searchPhotosMock = vi.fn()
const downloadPhotoMock = vi.fn()
vi.mock('../unsplash/service', () => ({
  searchPhotos: (...args: unknown[]) => searchPhotosMock(...args),
  downloadPhoto: (...args: unknown[]) => downloadPhotoMock(...args)
}))

import { UnsplashChannels } from '@memry/contracts/ipc-channels'
import type { UnsplashPhoto } from '@memry/contracts/unsplash-api'

import { registerUnsplashHandlers, unregisterUnsplashHandlers } from './unsplash-handlers'

const PHOTO: UnsplashPhoto = {
  id: 'abc123',
  thumbUrl: 'https://images.unsplash.com/photo-1?w=200',
  previewUrl: 'https://images.unsplash.com/photo-1?w=400',
  fullUrl: 'https://images.unsplash.com/photo-1?w=1080',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
  authorName: 'Ada Lovelace',
  htmlUrl: 'https://unsplash.com/photos/abc123',
  blurHash: null,
  width: 4000,
  height: 3000
}

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const handlerFor = (channel: string): Handler => {
  const entry = mockElectron.ipcMain.handle.mock.calls.find(([name]) => name === channel)
  if (!entry) throw new Error(`No handler registered for ${channel}`)
  return entry[1] as Handler
}

beforeEach(() => {
  unregisterUnsplashHandlers()
  vi.clearAllMocks()
  registerUnsplashHandlers()
})

describe('unsplash:search', () => {
  it('forwards a valid payload to the service', async () => {
    searchPhotosMock.mockResolvedValue({ ok: true, photos: [PHOTO], rateLimitRemaining: 12 })

    const result = await handlerFor(UnsplashChannels.invoke.SEARCH)(null, {
      query: 'mountains',
      page: 2
    })

    expect(searchPhotosMock).toHaveBeenCalledWith(
      { query: 'mountains', page: 2 },
      expect.objectContaining({ fetch: expect.any(Function) })
    )
    expect(result).toEqual({ ok: true, photos: [PHOTO], rateLimitRemaining: 12 })
  })

  it('rejects an invalid payload without reaching the service', async () => {
    const result = await handlerFor(UnsplashChannels.invoke.SEARCH)(null, { query: 42 })

    expect(result).toEqual({ ok: false, reason: 'failed' })
    expect(searchPhotosMock).not.toHaveBeenCalled()
  })
})

describe('unsplash:download', () => {
  it('forwards a valid payload to the service', async () => {
    downloadPhotoMock.mockResolvedValue({
      ok: true,
      ref: '../attachments/note-1/x-unsplash-abc123.jpg',
      credit: { name: PHOTO.authorName, url: PHOTO.htmlUrl }
    })

    const result = await handlerFor(UnsplashChannels.invoke.DOWNLOAD)(null, {
      noteId: 'note-1',
      photo: PHOTO
    })

    expect(downloadPhotoMock).toHaveBeenCalledWith(
      { noteId: 'note-1', photo: PHOTO },
      expect.objectContaining({ fetch: expect.any(Function) })
    )
    expect(result).toMatchObject({ ok: true, ref: '../attachments/note-1/x-unsplash-abc123.jpg' })
  })

  it('rejects a photo pointing at a non-Unsplash host', async () => {
    const result = await handlerFor(UnsplashChannels.invoke.DOWNLOAD)(null, {
      noteId: 'note-1',
      photo: { ...PHOTO, fullUrl: 'https://attacker.example/payload.jpg' }
    })

    expect(result).toEqual({ ok: false, reason: 'failed' })
    expect(downloadPhotoMock).not.toHaveBeenCalled()
  })

  it('rejects a download location that is not the Unsplash API host', async () => {
    const result = await handlerFor(UnsplashChannels.invoke.DOWNLOAD)(null, {
      noteId: 'note-1',
      photo: { ...PHOTO, downloadLocation: 'https://attacker.example/collect' }
    })

    expect(result).toEqual({ ok: false, reason: 'failed' })
    expect(downloadPhotoMock).not.toHaveBeenCalled()
  })
})

describe('teardown', () => {
  it('removes both channels', () => {
    unregisterUnsplashHandlers()

    expect(mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(UnsplashChannels.invoke.SEARCH)
    expect(mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(
      UnsplashChannels.invoke.DOWNLOAD
    )
  })
})
