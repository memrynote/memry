import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import handler, { VELOPACK_WINDOWS_SETUP_ASSET, resolveAssetUrl } from './download.ts'

const DOWNLOAD_BASE = 'https://github.com/memrynote/memry/releases/download/v1.2.3'

const asset = (name: string) => ({ name, browser_download_url: `${DOWNLOAD_BASE}/${name}` })

// Mirrors a real release: both Windows installers plus the blockmap sidecars.
const ASSETS = [
  asset('MemryNote-1.2.3-arm64.dmg'),
  asset('MemryNote-1.2.3-x64.dmg'),
  asset('MemryNote-1.2.3-win.zip'),
  asset('MemryNote-1.2.3-setup.exe'),
  asset('MemryNote-1.2.3-setup.exe.blockmap'),
  asset(VELOPACK_WINDOWS_SETUP_ASSET),
  asset('MemryNote-1.2.3-x64.AppImage'),
  asset('MemryNote-1.2.3-amd64.deb')
]

// Tags published before the Velopack switchover carry no Velopack installer.
const LEGACY_ASSETS = ASSETS.filter((item) => item.name !== VELOPACK_WINDOWS_SETUP_ASSET)

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
    assert.equal(resolveAssetUrl('mac-arm64', ASSETS), `${DOWNLOAD_BASE}/MemryNote-1.2.3-arm64.dmg`)
    assert.equal(resolveAssetUrl('mac-x64', ASSETS), `${DOWNLOAD_BASE}/MemryNote-1.2.3-x64.dmg`)
    assert.equal(resolveAssetUrl('linux', ASSETS), `${DOWNLOAD_BASE}/MemryNote-1.2.3-x64.AppImage`)
    assert.equal(resolveAssetUrl('linux-deb', ASSETS), `${DOWNLOAD_BASE}/MemryNote-1.2.3-amd64.deb`)
  })

  // The electron-builder `-setup.exe` is built on CI and never Authenticode-signed,
  // so SmartScreen refuses to unblock it. Only the Velopack installer is signed.
  it('prefers the signed Velopack installer for Windows', () => {
    assert.equal(
      resolveAssetUrl('windows', ASSETS),
      `${DOWNLOAD_BASE}/${VELOPACK_WINDOWS_SETUP_ASSET}`
    )
  })

  it('falls back to the NSIS installer on releases without a Velopack asset', () => {
    assert.equal(
      resolveAssetUrl('windows', LEGACY_ASSETS),
      `${DOWNLOAD_BASE}/MemryNote-1.2.3-setup.exe`
    )
  })

  it('never resolves a blockmap sidecar', () => {
    const blockmapOnly = [asset('MemryNote-1.2.3-setup.exe.blockmap')]
    assert.equal(resolveAssetUrl('windows', blockmapOnly), null)
  })

  it('refuses an asset URL outside the release download prefix', () => {
    const spoofed = [
      { name: VELOPACK_WINDOWS_SETUP_ASSET, browser_download_url: 'https://evil.example.com/x.exe' }
    ]
    assert.equal(resolveAssetUrl('windows', spoofed), null)
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
      assert.equal(result.redirectedTo, `${DOWNLOAD_BASE}/MemryNote-1.2.3-arm64.dmg`)
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
