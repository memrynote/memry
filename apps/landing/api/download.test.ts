import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import handler, { resolveAssetUrl } from './download.ts'

const ASSETS = [
  { name: 'Memrynote-1.2.3-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg' },
  { name: 'Memrynote-1.2.3-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
  { name: 'Memrynote-1.2.3-setup.exe', browser_download_url: 'https://example.com/setup.exe' },
  {
    name: 'Memrynote-1.2.3-x64.AppImage',
    browser_download_url: 'https://example.com/app.AppImage'
  },
  { name: 'Memrynote-1.2.3-amd64.deb', browser_download_url: 'https://example.com/app.deb' }
]

const RELEASES_PAGE_URL = 'https://github.com/memrynote/memry/releases/latest'

function createMockResponse() {
  let statusCode = 200
  let redirectedTo: string | null = null
  let body: unknown

  return {
    response: {
      status(code: number) {
        statusCode = code
        return this
      },
      json(payload: unknown) {
        body = payload
        return this
      },
      setHeader() {
        return this
      },
      redirect(code: number, url: string) {
        statusCode = code
        redirectedTo = url
        return this
      }
    },
    get statusCode() {
      return statusCode
    },
    get redirectedTo() {
      return redirectedTo
    },
    get body() {
      return body
    }
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('download asset resolution', () => {
  it('maps each platform to its versioned asset', () => {
    assert.equal(resolveAssetUrl('mac-arm64', ASSETS), 'https://example.com/arm64.dmg')
    assert.equal(resolveAssetUrl('mac-x64', ASSETS), 'https://example.com/x64.dmg')
    assert.equal(resolveAssetUrl('windows', ASSETS), 'https://example.com/setup.exe')
    assert.equal(resolveAssetUrl('linux', ASSETS), 'https://example.com/app.AppImage')
    assert.equal(resolveAssetUrl('linux-deb', ASSETS), 'https://example.com/app.deb')
  })

  it('returns null for an unknown platform or a missing asset', () => {
    assert.equal(resolveAssetUrl('bogus', ASSETS), null)
    assert.equal(resolveAssetUrl('mac-arm64', []), null)
  })
})

describe('download handler', () => {
  it('redirects to the resolved asset for a known platform', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ assets: ASSETS })

    try {
      const result = createMockResponse()
      await handler(
        { method: 'GET', query: { platform: 'mac-arm64' } } as never,
        result.response as never
      )

      assert.equal(result.statusCode, 302)
      assert.equal(result.redirectedTo, 'https://example.com/arm64.dmg')
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('falls back to the releases page for an unknown platform', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ assets: ASSETS })

    try {
      const result = createMockResponse()
      await handler(
        { method: 'GET', query: { platform: 'bogus' } } as never,
        result.response as never
      )

      assert.equal(result.statusCode, 302)
      assert.equal(result.redirectedTo, RELEASES_PAGE_URL)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('falls back to the releases page when the GitHub API errors', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ message: 'nope' }, 502)

    try {
      const result = createMockResponse()
      await handler(
        { method: 'GET', query: { platform: 'mac-arm64' } } as never,
        result.response as never
      )

      assert.equal(result.statusCode, 302)
      assert.equal(result.redirectedTo, RELEASES_PAGE_URL)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
