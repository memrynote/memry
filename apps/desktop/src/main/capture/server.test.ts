import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))

const ingestSpy = vi.fn(async () => ({ itemId: 'item-9' }))
vi.mock('../inbox/ingest', () => ({ ingestArticleCapture: ingestSpy }))

const TOKEN = 'b'.repeat(64)
let windowOpen = true
const origins = new Set<string>()
const openPairingWindowMock = vi.fn()
const mockUnpair = vi.fn()
vi.mock('./pairing', () => ({
  getCaptureToken: async () => TOKEN,
  isOriginAllowed: (o: string) => origins.has(o),
  isPairingWindowOpen: () => windowOpen,
  openPairingWindow: openPairingWindowMock,
  claimPairing: async (o: string) => {
    if (!windowOpen) return null
    origins.add(o)
    return { token: TOKEN }
  },
  unpairCapture: mockUnpair
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
    openPairingWindowMock.mockClear()
    mockUnpair.mockClear()
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

  it('passes a screenshot capture through to ingest', async () => {
    origins.add('chrome-extension://abc')
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
        mode: 'screenshot',
        contentMarkdown: '',
        excerpt: '',
        extractionStatus: 'full',
        properties: {
          title: 'x',
          source: 'https://example.com/p',
          created: '2026-06-17T00:00:00.000Z',
          tags: ['clippings']
        },
        screenshotDataUrl: 'data:image/png;base64,aGk=',
        force: true
      })
    })
    expect(cap.status).toBe(200)
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'screenshot',
        screenshotDataUrl: 'data:image/png;base64,aGk=',
        force: true
      }),
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

  // /pair/request tests
  it('/pair/request with no Origin header → 400 missing-origin', async () => {
    const r = await req(port, '/pair/request', {
      method: 'POST',
      headers: { 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('missing-origin')
  })

  it('/pair/request with non-chrome-extension origin → 403 origin-not-allowed', async () => {
    const r = await req(port, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'https://example.com', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('origin-not-allowed')
  })

  it('/pair/request for an allowlisted Firefox moz-extension origin → 200 already-paired', async () => {
    origins.add('moz-extension://ext-firefox')
    const r = await req(port, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'moz-extension://ext-firefox', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(200)
    expect((await r.json()).status).toBe('already-paired')
    expect(openPairingWindowMock).toHaveBeenCalledTimes(1)
  })

  it('/pair/request missing X-Memry-Capture header → 401 missing-capture-header', async () => {
    const r = await req(port, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://ext1' }
    })
    expect(r.status).toBe(401)
    expect((await r.json()).error).toBe('missing-capture-header')
  })

  it('/pair/request for already-allowlisted origin → 200 already-paired + openPairingWindow', async () => {
    origins.add('chrome-extension://ext-allowlisted')
    const r = await req(port, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://ext-allowlisted', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(200)
    expect((await r.json()).status).toBe('already-paired')
    expect(openPairingWindowMock).toHaveBeenCalledTimes(1)
  })

  it('/pair/request with consent=true → 202 pending, fires consent once, openPairingWindow called', async () => {
    let resolveFn!: (v: boolean) => void
    const consentPromise = new Promise<boolean>((resolve) => {
      resolveFn = resolve
    })
    const requestPairConsent = vi.fn(() => consentPromise)

    const { stopCaptureServer: stop, startCaptureServer: start } = await import('./server')
    await stop()
    const newPort = await start({ requestPairConsent })

    const r = await req(newPort, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://ext-consent-true', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(202)
    expect((await r.json()).status).toBe('pending')
    expect(requestPairConsent).toHaveBeenCalledTimes(1)
    expect(openPairingWindowMock).not.toHaveBeenCalled()

    resolveFn(true)
    // let the .then() run
    await new Promise((r) => setTimeout(r, 0))
    expect(openPairingWindowMock).toHaveBeenCalledTimes(1)

    await stop()
    // restore the server for afterEach
    port = await (await import('./server')).startCaptureServer()
  })

  it('/pair/request with consent=false → 202 pending, openPairingWindow NOT called', async () => {
    const requestPairConsent = vi.fn(async () => false)

    const { stopCaptureServer: stop, startCaptureServer: start } = await import('./server')
    await stop()
    const newPort = await start({ requestPairConsent })

    const r = await req(newPort, '/pair/request', {
      method: 'POST',
      headers: { Origin: 'chrome-extension://ext-consent-false', 'X-Memry-Capture': '1' }
    })
    expect(r.status).toBe(202)
    await new Promise((r) => setTimeout(r, 0))
    expect(openPairingWindowMock).not.toHaveBeenCalled()

    await stop()
    port = await (await import('./server')).startCaptureServer()
  })

  it('revokes pairing for an authorized origin', async () => {
    origins.add('chrome-extension://abc')
    const res = await req(port, '/pair/revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'chrome-extension://abc',
        'X-Memry-Capture': '1'
      }
    })
    expect(res.status).toBe(200)
    expect(mockUnpair).toHaveBeenCalledTimes(1)
  })

  it('rejects revoke with a bad token', async () => {
    origins.add('chrome-extension://abc')
    const res = await req(port, '/pair/revoke', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong',
        Origin: 'chrome-extension://abc',
        'X-Memry-Capture': '1'
      }
    })
    expect(res.status).toBe(401)
    expect(mockUnpair).not.toHaveBeenCalled()
  })

  it('single-pending guard: two concurrent /pair/request calls invoke consent only once', async () => {
    let resolveFn!: (v: boolean) => void
    const consentPromise = new Promise<boolean>((resolve) => {
      resolveFn = resolve
    })
    const requestPairConsent = vi.fn(() => consentPromise)

    const { stopCaptureServer: stop, startCaptureServer: start } = await import('./server')
    await stop()
    const newPort = await start({ requestPairConsent })

    const headers = { Origin: 'chrome-extension://ext-dedup', 'X-Memry-Capture': '1' }
    const [r1, r2] = await Promise.all([
      req(newPort, '/pair/request', { method: 'POST', headers }),
      req(newPort, '/pair/request', { method: 'POST', headers })
    ])
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    expect(requestPairConsent).toHaveBeenCalledTimes(1)

    resolveFn(true)
    await new Promise((r) => setTimeout(r, 0))

    await stop()
    port = await (await import('./server')).startCaptureServer()
  })
})
