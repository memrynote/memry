import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const saveAttachmentMock = vi.fn()
vi.mock('../vault/attachments', () => ({
  saveAttachment: (...args: unknown[]) => saveAttachmentMock(...args)
}))

const emitNoteAttachmentSavedMock = vi.fn()
vi.mock('../notes/runtime-effects', () => ({
  emitNoteAttachmentSaved: (...args: unknown[]) => emitNoteAttachmentSavedMock(...args)
}))

import type { UnsplashPhoto } from '@memry/contracts/unsplash-api'

import {
  downloadPhoto,
  isAvailable,
  resetUnsplashCacheForTests,
  searchPhotos,
  type UnsplashResponse
} from './service'

const ACCESS_KEY = 'test-access-key'

const PHOTO: UnsplashPhoto = {
  id: 'abc123',
  thumbUrl: 'https://images.unsplash.com/photo-1?w=200',
  previewUrl: 'https://images.unsplash.com/photo-1?w=400',
  fullUrl: 'https://images.unsplash.com/photo-1?w=1080',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
  authorName: 'Ada Lovelace',
  htmlUrl: 'https://unsplash.com/photos/abc123',
  blurHash: 'LKO2ll',
  width: 4000,
  height: 3000
}

const RAW_PHOTO = {
  id: PHOTO.id,
  urls: { thumb: PHOTO.thumbUrl, small: PHOTO.previewUrl, regular: PHOTO.fullUrl },
  links: { download_location: PHOTO.downloadLocation, html: PHOTO.htmlUrl },
  user: { name: PHOTO.authorName },
  blur_hash: PHOTO.blurHash,
  width: PHOTO.width,
  height: PHOTO.height
}

function response(init: {
  ok?: boolean
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
  bytes?: Uint8Array
}): UnsplashResponse {
  const headers = init.headers ?? {}
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get: (name) => headers[name] ?? null
    },
    json: async () => init.json,
    text: async () => init.text ?? '',
    arrayBuffer: async () => (init.bytes ?? new Uint8Array([1, 2, 3])).buffer as ArrayBuffer
  }
}

const searchOk = (results: unknown[], headers?: Record<string, string>) =>
  response({ json: { results }, headers })

beforeEach(() => {
  vi.clearAllMocks()
  resetUnsplashCacheForTests()
  process.env.MEMRY_UNSPLASH_ACCESS_KEY = ACCESS_KEY
  saveAttachmentMock.mockResolvedValue({
    success: true,
    path: '../attachments/note-1/x1y2z3-unsplash-abc123.jpg',
    diskPath: '/vault/attachments/note-1/x1y2z3-unsplash-abc123.jpg'
  })
})

describe('isAvailable', () => {
  it('is false when no access key is configured', () => {
    delete process.env.MEMRY_UNSPLASH_ACCESS_KEY
    expect(isAvailable()).toBe(false)
  })

  it('is false when the key is only whitespace', () => {
    process.env.MEMRY_UNSPLASH_ACCESS_KEY = '   '
    expect(isAvailable()).toBe(false)
  })

  it('is true when a key is configured', () => {
    expect(isAvailable()).toBe(true)
  })
})

describe('searchPhotos', () => {
  it('reports not-configured without a network call when no key is set', async () => {
    delete process.env.MEMRY_UNSPLASH_ACCESS_KEY
    const fetch = vi.fn()

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'not-configured'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('short-circuits a whitespace-only query without a network call', async () => {
    const fetch = vi.fn()

    await expect(searchPhotos({ query: '   ' }, { fetch })).resolves.toEqual({
      ok: true,
      photos: [],
      rateLimitRemaining: null
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the Client-ID header and returns photos with the remaining rate limit', async () => {
    const fetch = vi.fn(async () => searchOk([RAW_PHOTO], { 'X-Ratelimit-Remaining': '47' }))

    const result = await searchPhotos({ query: 'mountains' }, { fetch })

    expect(result).toEqual({ ok: true, photos: [PHOTO], rateLimitRemaining: 47 })
    const [url, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toContain('query=mountains')
    expect(init.headers.Authorization).toBe(`Client-ID ${ACCESS_KEY}`)
  })

  it('reports a null rate limit when the header is absent', async () => {
    const fetch = vi.fn(async () => searchOk([RAW_PHOTO]))

    const result = await searchPhotos({ query: 'mountains' }, { fetch })

    expect(result).toEqual({ ok: true, photos: [PHOTO], rateLimitRemaining: null })
  })

  it('drops a result whose URLs are not on an Unsplash host', async () => {
    const impostor = {
      ...RAW_PHOTO,
      id: 'evil',
      links: { ...RAW_PHOTO.links, download_location: 'https://attacker.example/steal' }
    }
    const fetch = vi.fn(async () => searchOk([impostor, RAW_PHOTO]))

    const result = await searchPhotos({ query: 'mountains' }, { fetch })

    expect(result).toEqual({ ok: true, photos: [PHOTO], rateLimitRemaining: null })
  })

  it('serves a repeated query and page from the session cache', async () => {
    const fetch = vi.fn(async () => searchOk([RAW_PHOTO]))

    await searchPhotos({ query: 'mountains', page: 2 }, { fetch })
    await searchPhotos({ query: 'mountains', page: 2 }, { fetch })

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches again for a different page of the same query', async () => {
    const fetch = vi.fn(async () => searchOk([RAW_PHOTO]))

    await searchPhotos({ query: 'mountains', page: 1 }, { fetch })
    await searchPhotos({ query: 'mountains', page: 2 }, { fetch })

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps a 403 rate-limit body to rate-limited', async () => {
    const fetch = vi.fn(async () =>
      response({ ok: false, status: 403, text: '{"errors":["Rate Limit Exceeded"]}' })
    )

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
  })

  it('maps a 403 with an exhausted rate-limit header to rate-limited', async () => {
    const fetch = vi.fn(async () =>
      response({ ok: false, status: 403, headers: { 'X-Ratelimit-Remaining': '0' } })
    )

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
  })

  it('maps a 429 to rate-limited', async () => {
    const fetch = vi.fn(async () => response({ ok: false, status: 429 }))

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
  })

  it('maps a 403 that is not about the rate limit to failed', async () => {
    const fetch = vi.fn(async () =>
      response({ ok: false, status: 403, text: '{"errors":["Forbidden"]}' })
    )

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('maps a network error to offline', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.unsplash.com')
    })

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'offline'
    })
  })

  it('maps a server error to failed', async () => {
    const fetch = vi.fn(async () => response({ ok: false, status: 500 }))

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('maps a body without a results array to failed', async () => {
    const fetch = vi.fn(async () => response({ json: { errors: ['nope'] } }))

    await expect(searchPhotos({ query: 'mountains' }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('does not cache a failure', async () => {
    const fetch = vi
      .fn<(url: string) => Promise<UnsplashResponse>>()
      .mockResolvedValueOnce(response({ ok: false, status: 500 }))
      .mockResolvedValueOnce(searchOk([RAW_PHOTO]))

    await searchPhotos({ query: 'mountains' }, { fetch })
    const second = await searchPhotos({ query: 'mountains' }, { fetch })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(second).toEqual({ ok: true, photos: [PHOTO], rateLimitRemaining: null })
  })
})

describe('downloadPhoto', () => {
  function trackingFetch(overrides: Partial<Record<'ping' | 'bytes', UnsplashResponse>> = {}) {
    const calls: string[] = []
    const fetch = vi.fn(async (url: string) => {
      calls.push(url)
      if (url === PHOTO.downloadLocation) {
        return overrides.ping ?? response({ json: { url: PHOTO.fullUrl } })
      }
      return overrides.bytes ?? response({ headers: { 'Content-Type': 'image/jpeg' } })
    })
    return { fetch, calls }
  }

  it('reports not-configured without a network call when no key is set', async () => {
    delete process.env.MEMRY_UNSPLASH_ACCESS_KEY
    const { fetch } = trackingFetch()

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'not-configured'
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
  })

  it('pings the download location exactly once, before fetching the bytes', async () => {
    const { fetch, calls } = trackingFetch()

    await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(calls).toEqual([PHOTO.downloadLocation, PHOTO.fullUrl])
    expect(calls.filter((url) => url === PHOTO.downloadLocation)).toHaveLength(1)
  })

  it('sends the Client-ID header on the tracking ping', async () => {
    const { fetch } = trackingFetch()

    await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    const [, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers.Authorization).toBe(`Client-ID ${ACCESS_KEY}`)
  })

  it('still saves the cover when the tracking ping fails', async () => {
    const { fetch } = trackingFetch({ ping: response({ ok: false, status: 500 }) })

    const result = await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(result.ok).toBe(true)
    expect(saveAttachmentMock).toHaveBeenCalledTimes(1)
  })

  it('returns a note-relative ref with no scheme and no absolute path, plus the credit', async () => {
    const { fetch } = trackingFetch()

    const result = await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(result).toEqual({
      ok: true,
      ref: '../attachments/note-1/x1y2z3-unsplash-abc123.jpg',
      credit: { name: PHOTO.authorName, url: PHOTO.htmlUrl }
    })
    if (!result.ok) throw new Error('expected a successful download')
    expect(result.ref).not.toMatch(/^[a-zA-Z][a-zA-Z\d+\-.]*:/)
    expect(result.ref.startsWith('/')).toBe(false)
  })

  it('writes the bytes into the note through the shared attachment path', async () => {
    const { fetch } = trackingFetch({
      bytes: response({ headers: { 'Content-Type': 'image/png' }, bytes: new Uint8Array([9, 9]) })
    })

    await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(saveAttachmentMock).toHaveBeenCalledWith(
      'note-1',
      Buffer.from([9, 9]),
      'unsplash-abc123.png'
    )
  })

  it('emits the sync event so the cover reaches other devices', async () => {
    const { fetch } = trackingFetch()

    await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(emitNoteAttachmentSavedMock).toHaveBeenCalledWith(
      'note-1',
      '/vault/attachments/note-1/x1y2z3-unsplash-abc123.jpg'
    )
  })

  it('refuses a ref that carries a URL scheme', async () => {
    saveAttachmentMock.mockResolvedValue({
      success: true,
      path: 'memry-file://local/vault/attachments/note-1/x-unsplash-abc123.jpg',
      diskPath: '/vault/attachments/note-1/x-unsplash-abc123.jpg'
    })
    const { fetch } = trackingFetch()

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'write-failed'
    })
    expect(emitNoteAttachmentSavedMock).not.toHaveBeenCalled()
  })

  it('refuses an absolute vault path as a ref', async () => {
    saveAttachmentMock.mockResolvedValue({
      success: true,
      path: '/vault/attachments/note-1/x-unsplash-abc123.jpg',
      diskPath: '/vault/attachments/note-1/x-unsplash-abc123.jpg'
    })
    const { fetch } = trackingFetch()

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'write-failed'
    })
  })

  it('reports write-failed when the vault write is rejected', async () => {
    saveAttachmentMock.mockResolvedValue({ success: false, error: 'disk full' })
    const { fetch } = trackingFetch()

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'write-failed'
    })
  })

  it('maps a network error on the byte fetch to offline', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === PHOTO.downloadLocation) return response({ json: {} })
      throw new Error('socket hang up')
    })

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'offline'
    })
    expect(saveAttachmentMock).not.toHaveBeenCalled()
  })

  it('maps a rate-limited byte fetch to rate-limited', async () => {
    const { fetch } = trackingFetch({ bytes: response({ ok: false, status: 429 }) })

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
  })

  it('maps a failed byte fetch to failed', async () => {
    const { fetch } = trackingFetch({ bytes: response({ ok: false, status: 404 }) })

    await expect(downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('falls back to a jpg extension when the response carries no content type', async () => {
    const { fetch } = trackingFetch({ bytes: response({}) })

    await downloadPhoto({ noteId: 'note-1', photo: PHOTO }, { fetch })

    expect(saveAttachmentMock).toHaveBeenCalledWith(
      'note-1',
      expect.any(Buffer),
      'unsplash-abc123.jpg'
    )
  })
})
