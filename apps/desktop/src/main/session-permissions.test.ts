import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  is: { dev: false },
  defaultSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn()
  }
}))

vi.mock('electron', () => ({ session: { defaultSession: mocks.defaultSession } }))
vi.mock('@electron-toolkit/utils', () => ({ is: mocks.is }))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  configureSessionPermissions,
  isPermissionAllowed,
  isTrustedAppOrigin,
  type PermissionPolicyOptions
} from './session-permissions'

const prod: PermissionPolicyOptions = { allowDevServerOrigins: false }
const dev: PermissionPolicyOptions = { allowDevServerOrigins: true }

const FILE_ORIGIN = 'file:///'
const DEV_ORIGIN = 'http://localhost:5173'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.is.dev = false
})

describe('isTrustedAppOrigin', () => {
  it('trusts the packaged renderer file:// origin', () => {
    expect(isTrustedAppOrigin('file:///', prod)).toBe(true)
    expect(isTrustedAppOrigin('file:///Users/x/app/renderer/index.html', prod)).toBe(true)
  })

  it('trusts the memry-file:// vault asset scheme', () => {
    expect(isTrustedAppOrigin('memry-file://local', prod)).toBe(true)
  })

  it('trusts localhost dev-server origins only when dev origins are enabled', () => {
    expect(isTrustedAppOrigin('http://localhost:5173', dev)).toBe(true)
    expect(isTrustedAppOrigin('http://127.0.0.1:5173', dev)).toBe(true)
    expect(isTrustedAppOrigin('http://localhost:5173', prod)).toBe(false)
    expect(isTrustedAppOrigin('http://127.0.0.1:5173', prod)).toBe(false)
  })

  it('rejects external and lookalike origins even in dev', () => {
    expect(isTrustedAppOrigin('https://www.youtube-nocookie.com', dev)).toBe(false)
    expect(isTrustedAppOrigin('https://evil.example', dev)).toBe(false)
    expect(isTrustedAppOrigin('http://localhost.evil.example', dev)).toBe(false)
    expect(isTrustedAppOrigin('https://localhost:5173', prod)).toBe(false)
  })

  it('rejects opaque, empty, and malformed origins', () => {
    expect(isTrustedAppOrigin('null', prod)).toBe(false)
    expect(isTrustedAppOrigin('', prod)).toBe(false)
    expect(isTrustedAppOrigin(undefined, prod)).toBe(false)
    expect(isTrustedAppOrigin('not a url', prod)).toBe(false)
    expect(isTrustedAppOrigin('data:text/html,hi', prod)).toBe(false)
  })
})

describe('isPermissionAllowed', () => {
  it('allows microphone-only media from the app origin', () => {
    expect(isPermissionAllowed('media', FILE_ORIGIN, { mediaTypes: ['audio'] }, prod)).toBe(true)
    expect(isPermissionAllowed('media', DEV_ORIGIN, { mediaTypes: ['audio'] }, dev)).toBe(true)
  })

  it('allows media checks without explicit media types from the app origin', () => {
    expect(isPermissionAllowed('media', FILE_ORIGIN, {}, prod)).toBe(true)
  })

  it('denies media whenever video or unknown capture is requested', () => {
    expect(isPermissionAllowed('media', FILE_ORIGIN, { mediaTypes: ['video'] }, prod)).toBe(false)
    expect(
      isPermissionAllowed('media', FILE_ORIGIN, { mediaTypes: ['audio', 'video'] }, prod)
    ).toBe(false)
    expect(isPermissionAllowed('media', FILE_ORIGIN, { mediaTypes: ['unknown'] }, prod)).toBe(false)
  })

  it('allows clipboard and notification permissions from the app origin', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', FILE_ORIGIN, {}, prod)).toBe(true)
    expect(isPermissionAllowed('clipboard-read', FILE_ORIGIN, {}, prod)).toBe(true)
    expect(isPermissionAllowed('notifications', FILE_ORIGIN, {}, prod)).toBe(true)
  })

  it('allows fileSystem from the app origin so the canvas library can import files', () => {
    // Excalidraw's library panel reads .excalidrawlib through the File System
    // Access API; denying this let the picker open and then failed the read.
    expect(isPermissionAllowed('fileSystem', FILE_ORIGIN, {}, prod)).toBe(true)
    expect(isPermissionAllowed('fileSystem', DEV_ORIGIN, {}, dev)).toBe(true)
  })

  it('denies allowlisted permissions from untrusted origins', () => {
    for (const permission of [
      'media',
      'clipboard-sanitized-write',
      'clipboard-read',
      'notifications',
      'fileSystem'
    ]) {
      expect(
        isPermissionAllowed(
          permission,
          'https://www.youtube-nocookie.com',
          { mediaTypes: ['audio'] },
          prod
        )
      ).toBe(false)
      expect(isPermissionAllowed(permission, 'https://evil.example', {}, dev)).toBe(false)
      expect(isPermissionAllowed(permission, undefined, {}, prod)).toBe(false)
    }
  })

  it('denies every permission outside the allowlist even from the app origin', () => {
    const denied = [
      'geolocation',
      'fullscreen',
      'display-capture',
      'pointerLock',
      'keyboardLock',
      'idle-detection',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'bluetooth',
      'mediaKeySystem',
      'openExternal',
      'speaker-selection',
      'storage-access',
      'top-level-storage-access',
      'window-management',
      'deprecated-sync-clipboard-read',
      'unknown'
    ]
    for (const permission of denied) {
      expect(isPermissionAllowed(permission, FILE_ORIGIN, {}, prod)).toBe(false)
      expect(isPermissionAllowed(permission, DEV_ORIGIN, {}, dev)).toBe(false)
    }
  })
})

type RequestHandler = (
  webContents: { getURL: () => string },
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>
) => void

type CheckHandler = (
  webContents: null,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>
) => boolean

function wireHandlers(): { request: RequestHandler; check: CheckHandler } {
  configureSessionPermissions()
  const request = mocks.defaultSession.setPermissionRequestHandler.mock
    .calls[0]?.[0] as unknown as RequestHandler
  const check = mocks.defaultSession.setPermissionCheckHandler.mock
    .calls[0]?.[0] as unknown as CheckHandler
  return { request, check }
}

describe('configureSessionPermissions', () => {
  it('registers both a request handler and a check handler on the default session', () => {
    configureSessionPermissions()
    expect(mocks.defaultSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(mocks.defaultSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(mocks.defaultSession.setPermissionRequestHandler.mock.calls[0]?.[0]).toBeTypeOf(
      'function'
    )
    expect(mocks.defaultSession.setPermissionCheckHandler.mock.calls[0]?.[0]).toBeTypeOf('function')
  })

  it('grants the voice recorder microphone request from the packaged app', () => {
    const { request } = wireHandlers()
    const callback = vi.fn()
    request({ getURL: () => FILE_ORIGIN }, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'file:///renderer/index.html',
      mediaTypes: ['audio']
    })
    expect(callback).toHaveBeenCalledWith(true)
  })

  it('denies a video capture request even from the app origin', () => {
    const { request } = wireHandlers()
    const callback = vi.fn()
    request({ getURL: () => FILE_ORIGIN }, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'file:///renderer/index.html',
      mediaTypes: ['audio', 'video']
    })
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('denies non-allowlisted permission requests', () => {
    const { request } = wireHandlers()
    const callback = vi.fn()
    request({ getURL: () => FILE_ORIGIN }, 'geolocation', callback, {
      isMainFrame: true,
      requestingUrl: 'file:///renderer/index.html'
    })
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('denies allowlisted permissions requested by an embedded external frame', () => {
    const { request } = wireHandlers()
    const callback = vi.fn()
    request({ getURL: () => FILE_ORIGIN }, 'notifications', callback, {
      isMainFrame: false,
      requestingUrl: 'https://www.youtube-nocookie.com/embed/x'
    })
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('falls back to the webContents URL when requestingUrl is empty', () => {
    const { request } = wireHandlers()
    const callback = vi.fn()
    request({ getURL: () => 'file:///renderer/index.html' }, 'notifications', callback, {
      isMainFrame: true,
      requestingUrl: ''
    })
    expect(callback).toHaveBeenCalledWith(true)
  })

  it('answers permission checks consistently with permission requests', () => {
    const { request, check } = wireHandlers()
    const grid: Array<{ permission: string; origin: string; mediaType?: string }> = [
      { permission: 'media', origin: FILE_ORIGIN, mediaType: 'audio' },
      { permission: 'media', origin: FILE_ORIGIN, mediaType: 'video' },
      { permission: 'media', origin: 'https://evil.example', mediaType: 'audio' },
      { permission: 'notifications', origin: FILE_ORIGIN },
      { permission: 'notifications', origin: 'https://evil.example' },
      { permission: 'clipboard-read', origin: FILE_ORIGIN },
      { permission: 'clipboard-sanitized-write', origin: FILE_ORIGIN },
      { permission: 'geolocation', origin: FILE_ORIGIN },
      { permission: 'fullscreen', origin: FILE_ORIGIN },
      { permission: 'openExternal', origin: FILE_ORIGIN }
    ]
    for (const { permission, origin, mediaType } of grid) {
      const callback = vi.fn()
      request(
        { getURL: () => origin },
        permission,
        callback,
        mediaType === undefined
          ? { isMainFrame: true, requestingUrl: origin }
          : { isMainFrame: true, requestingUrl: origin, mediaTypes: [mediaType] }
      )
      const requested = callback.mock.calls[0]?.[0] as boolean
      const checked = check(
        null,
        permission,
        origin,
        mediaType === undefined ? { isMainFrame: true } : { isMainFrame: true, mediaType }
      )
      expect(checked, `${permission} from ${origin}`).toBe(requested)
    }
  })

  it('grants Notification.permission checks from the app origin so inbox notifications keep working', () => {
    const { check } = wireHandlers()
    expect(check(null, 'notifications', FILE_ORIGIN, { isMainFrame: true })).toBe(true)
  })

  it('denies unknown-media permission checks', () => {
    const { check } = wireHandlers()
    expect(check(null, 'media', FILE_ORIGIN, { isMainFrame: true, mediaType: 'unknown' })).toBe(
      false
    )
  })

  it('trusts dev-server origins only when running in dev mode', () => {
    mocks.is.dev = true
    const { check } = wireHandlers()
    expect(check(null, 'notifications', DEV_ORIGIN, { isMainFrame: true })).toBe(true)

    vi.clearAllMocks()
    mocks.is.dev = false
    const { check: prodCheck } = wireHandlers()
    expect(prodCheck(null, 'notifications', DEV_ORIGIN, { isMainFrame: true })).toBe(false)
  })
})
