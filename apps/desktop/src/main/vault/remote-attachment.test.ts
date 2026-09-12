/**
 * A link is user input pointing at a host we do not control, so the tests pin
 * what never reaches the vault: a page that answers HTML, a body over the cap,
 * and a ref that would only resolve on this machine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveAttachment = vi.hoisted(() => vi.fn())
const emitNoteAttachmentSaved = vi.hoisted(() => vi.fn())

vi.mock('./attachments', () => ({ saveAttachment }))
vi.mock('../notes/runtime-effects', () => ({ emitNoteAttachmentSaved }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { downloadAttachmentFromUrl, type RemoteFetchResponse } from './remote-attachment'

const NOTE_ID = 'nte_9f2c1a'

interface ResponseSpec {
  ok?: boolean
  status?: number
  headers?: Record<string, string>
  arrayBuffer?: () => Promise<ArrayBuffer>
}

function response(spec: ResponseSpec): RemoteFetchResponse {
  const headers = spec.headers ?? {}
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    headers: { get: (name) => headers[name] ?? null },
    arrayBuffer: spec.arrayBuffer ?? (async () => new Uint8Array([1, 2, 3]).buffer)
  }
}

const download = (url: string, fetchImpl: () => Promise<RemoteFetchResponse>) =>
  downloadAttachmentFromUrl({ noteId: NOTE_ID, url }, { fetch: fetchImpl })

beforeEach(() => {
  saveAttachment.mockReset().mockResolvedValue({
    success: true,
    path: '../attachments/nte_9f2c1a/harbour.jpg',
    diskPath: '/v/a.jpg'
  })
  emitNoteAttachmentSaved.mockReset()
})

describe('downloadAttachmentFromUrl', () => {
  it('stores the bytes under a name taken from the link and announces the save', async () => {
    const result = await download('https://example.com/photos/harbour.jpg', async () =>
      response({ headers: { 'Content-Type': 'image/jpeg' } })
    )

    expect(result).toEqual({ ok: true, ref: '../attachments/nte_9f2c1a/harbour.jpg' })
    expect(saveAttachment).toHaveBeenCalledWith(NOTE_ID, expect.any(Buffer), 'harbour.jpg')
    expect(emitNoteAttachmentSaved).toHaveBeenCalledWith(NOTE_ID, '/v/a.jpg')
  })

  it('refuses a link to a page rather than to an image', async () => {
    const result = await download('https://example.com/photos/harbour', async () =>
      response({ headers: { 'Content-Type': 'text/html' } })
    )

    expect(result).toEqual({ ok: false, reason: 'not-an-image' })
    expect(saveAttachment).not.toHaveBeenCalled()
  })

  it('refuses a body over the cap even when the declared length lied', async () => {
    const result = await download('https://example.com/huge.png', async () =>
      response({
        headers: { 'Content-Type': 'image/png', 'Content-Length': '10' },
        arrayBuffer: async () => new Uint8Array(26 * 1024 * 1024).buffer
      })
    )

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    expect(saveAttachment).not.toHaveBeenCalled()
  })

  it('reads an unreachable host as offline and an error status as a failure', async () => {
    await expect(
      download('https://example.com/x.png', async () => {
        throw new Error('ENOTFOUND')
      })
    ).resolves.toEqual({ ok: false, reason: 'offline' })

    await expect(
      download('https://example.com/x.png', async () => response({ ok: false, status: 404 }))
    ).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('refuses a ref that names this machine rather than the vault', async () => {
    saveAttachment.mockResolvedValue({
      success: true,
      path: 'memry-file://local/Users/k/vault/attachments/nte_9f2c1a/harbour.jpg'
    })

    const result = await download('https://example.com/harbour.jpg', async () =>
      response({ headers: { 'Content-Type': 'image/jpeg' } })
    )

    expect(result).toEqual({ ok: false, reason: 'write-failed' })
  })
})
