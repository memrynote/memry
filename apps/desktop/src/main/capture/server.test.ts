import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))

const ingestSpy = vi.fn(async () => ({ itemId: 'item-9' }))
vi.mock('../inbox/ingest', () => ({ ingestArticleCapture: ingestSpy }))

const TOKEN = 'b'.repeat(64)
let windowOpen = true
const origins = new Set<string>()
vi.mock('./pairing', () => ({
  getCaptureToken: async () => TOKEN,
  isOriginAllowed: (o: string) => origins.has(o),
  isPairingWindowOpen: () => windowOpen,
  claimPairing: async (o: string) => {
    if (!windowOpen) return null
    origins.add(o)
    return { token: TOKEN }
  }
}))

async function req(port: number, path: string, init: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, init)
}

describe('capture server', () => {
  let port: number
  beforeEach(async () => {
    windowOpen = true
    origins.clear()
    ingestSpy.mockClear()
    const { startCaptureServer } = await import('./server')
    port = await startCaptureServer()
  })
  afterEach(async () => {
    const { stopCaptureServer } = await import('./server')
    await stopCaptureServer()
  })

  it('answers /ping unauthenticated', async () => {
    const r = await req(port, '/ping', { method: 'GET' })
    expect(r.status).toBe(200)
    expect((await r.json()).app).toBe('memry')
  })

  it('claims a token while the window is open, then serves /capture', async () => {
    const claim = await req(port, '/pair/claim', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://abc', 'X-Memry-Capture': '1' }
    })
    expect(claim.status).toBe(200)
    const { token } = await claim.json()
    expect(token).toBe(TOKEN)

    const cap = await req(port, '/capture', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'chrome-extension://abc',
        'X-Memry-Capture': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: 'https://example.com/p',
        mode: 'article',
        contentMarkdown: '# x',
        excerpt: 'x',
        extractionStatus: 'full',
        properties: {
          title: 'x',
          source: 'https://example.com/p',
          created: '2026-06-17T00:00:00.000Z',
          tags: ['clippings']
        }
      })
    })
    expect(cap.status).toBe(200)
    expect((await cap.json()).itemId).toBe('item-9')
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'article' }),
      'browser-extension'
    )
  })

  it('rejects /capture without the custom header', async () => {
    origins.add('chrome-extension://abc')
    const r = await req(port, '/capture', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'chrome-extension://abc',
        'Content-Type': 'application/json'
      },
      body: '{}'
    })
    expect(r.status).toBe(401)
    expect(ingestSpy).not.toHaveBeenCalled()
  })

  it('rejects /pair/claim when the window is closed', async () => {
    windowOpen = false
    const r = await req(port, '/pair/claim', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://abc', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(403)
  })
})
