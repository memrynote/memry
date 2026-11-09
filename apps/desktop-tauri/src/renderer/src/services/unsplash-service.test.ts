import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unsplashService } from './unsplash-service'

const commands = vi.hoisted(() => ({
  unsplashSearch: vi.fn(),
  notesDownloadUnsplashPhoto: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

beforeEach(() => {
  commands.unsplashSearch.mockReset()
  commands.notesDownloadUnsplashPhoto.mockReset()
})

describe('unsplashService.search', () => {
  it('hands the picker the contract shape for a page of photos', async () => {
    const photo = { id: 'a', thumbUrl: 't', previewUrl: 'p', fullUrl: 'f' }
    commands.unsplashSearch.mockResolvedValue({
      status: 'photos',
      photos: [photo],
      rateLimitRemaining: 47
    })

    await expect(unsplashService.search({ query: 'mountains', page: 2 })).resolves.toEqual({
      ok: true,
      photos: [photo],
      rateLimitRemaining: 47
    })
    expect(commands.unsplashSearch).toHaveBeenCalledWith('mountains', 2)
  })

  it('sends a missing page as null and keeps a failure reason the picker branches on', async () => {
    commands.unsplashSearch.mockResolvedValue({ status: 'unavailable', reason: 'not-configured' })

    await expect(unsplashService.search({ query: '' })).resolves.toEqual({
      ok: false,
      reason: 'not-configured'
    })
    expect(commands.unsplashSearch).toHaveBeenCalledWith('', null)
  })
})

describe('unsplashService.download', () => {
  const photo = { id: 'a', thumbUrl: 't', previewUrl: 'p', fullUrl: 'f' }

  it('answers the saved ref and the credit in the contract shape', async () => {
    const credit = { name: 'Ada', url: 'https://unsplash.com/photos/a' }
    commands.notesDownloadUnsplashPhoto.mockResolvedValue({
      status: 'saved',
      ref: '../attachments/n1/x-unsplash-a.jpg',
      credit
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the command only passes the photo on
    const input = { noteId: 'n1', photo } as unknown as Parameters<
      typeof unsplashService.download
    >[0]
    await expect(unsplashService.download(input)).resolves.toEqual({
      ok: true,
      ref: '../attachments/n1/x-unsplash-a.jpg',
      credit
    })
    expect(commands.notesDownloadUnsplashPhoto).toHaveBeenCalledWith('n1', photo)
  })

  it('keeps the reason of a failed fetch and names a refused write', async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the command only passes the photo on
    const input = { noteId: 'n1', photo } as unknown as Parameters<
      typeof unsplashService.download
    >[0]
    commands.notesDownloadUnsplashPhoto.mockResolvedValue({
      status: 'unavailable',
      reason: 'rate-limited'
    })
    await expect(unsplashService.download(input)).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
    commands.notesDownloadUnsplashPhoto.mockResolvedValue({ status: 'writeFailed' })
    await expect(unsplashService.download(input)).resolves.toEqual({
      ok: false,
      reason: 'write-failed'
    })
  })
})
