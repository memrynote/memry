import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unsplashService } from './unsplash-service'

const commands = vi.hoisted(() => ({ unsplashSearch: vi.fn() }))

vi.mock('../../../generated/bindings', () => ({ commands }))

beforeEach(() => commands.unsplashSearch.mockReset())

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
