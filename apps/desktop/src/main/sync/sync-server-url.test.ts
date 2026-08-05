import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveSyncServerUrl } from './sync-server-url'

const ORIGINAL_URL = process.env.SYNC_SERVER_URL
const DEV_FALLBACK = 'http://localhost:8787'

function setEnvUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.SYNC_SERVER_URL
  else process.env.SYNC_SERVER_URL = value
}

describe('resolveSyncServerUrl', () => {
  beforeEach(() => {
    setEnvUrl(undefined)
  })

  afterEach(() => {
    setEnvUrl(ORIGINAL_URL)
  })

  describe('lazy resolution', () => {
    // The regression this module exists for: a module-level
    // `const URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'`
    // froze to the fallback because main loads `.env.<environment>` via dotenv
    // AFTER the IPC handler modules are imported. In `dev` the fallback happens
    // to equal `.env.dev`, so the bug was invisible; in `dev:staging` it pinned
    // OAuth and sync to localhost.
    it('reflects an env value that was set after the module was imported', () => {
      // This module was imported at the top of the file, with the var unset.
      expect(process.env.SYNC_SERVER_URL).toBeUndefined()

      process.env.SYNC_SERVER_URL = 'https://sync-staging.memrynote.com'

      expect(resolveSyncServerUrl()).toBe('https://sync-staging.memrynote.com')
    })

    it('picks up a changed env on the very next call', () => {
      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com'
      expect(resolveSyncServerUrl()).toBe('https://sync.memrynote.com')

      process.env.SYNC_SERVER_URL = 'https://sync-staging.memrynote.com'
      expect(resolveSyncServerUrl()).toBe('https://sync-staging.memrynote.com')

      setEnvUrl(undefined)
      expect(resolveSyncServerUrl()).toBe(DEV_FALLBACK)
    })

    it('imports cleanly with no env configured and still resolves later', async () => {
      // Import-time throws are what made the eager version untestable; a fresh
      // import with nothing configured must not blow up.
      vi.resetModules()
      const fresh = await import('./sync-server-url')

      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com'
      expect(fresh.resolveSyncServerUrl()).toBe('https://sync.memrynote.com')
    })
  })

  describe('absent or empty configuration', () => {
    it('falls back to the local dev server when unset', () => {
      expect(resolveSyncServerUrl()).toBe(DEV_FALLBACK)
    })

    it('treats an empty value as absent rather than returning an empty host', () => {
      process.env.SYNC_SERVER_URL = ''
      expect(resolveSyncServerUrl()).toBe(DEV_FALLBACK)
    })
  })

  describe('configured values', () => {
    it('returns a configured URL verbatim, never rewriting scheme, host or port', () => {
      for (const configured of [
        'https://sync.memrynote.com',
        'https://sync-staging.memrynote.com',
        'http://127.0.0.1:8787',
        'http://localhost:9999'
      ]) {
        process.env.SYNC_SERVER_URL = configured
        const resolved = resolveSyncServerUrl()
        expect(resolved).toBe(configured)
        expect(new URL(resolved).host).toBe(new URL(configured).host)
      }
    })

    it('does not normalize a trailing slash', () => {
      // Callers build paths with `${url}/auth/...`, so a trailing slash in the
      // env yields a double slash. Recorded as current behaviour: this module
      // is a raw reader, normalization (if ever wanted) belongs to the caller.
      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com/'
      expect(resolveSyncServerUrl()).toBe('https://sync.memrynote.com/')
    })

    it('never silently substitutes the default for a present-but-malformed value', () => {
      // The dangerous failure mode would be swallowing a typo and quietly
      // talking to localhost instead. A malformed value comes back verbatim, so
      // the first request against it fails loudly at the call site.
      process.env.SYNC_SERVER_URL = 'sync.memrynote.com'
      const resolved = resolveSyncServerUrl()

      expect(resolved).toBe('sync.memrynote.com')
      expect(resolved).not.toBe(DEV_FALLBACK)
      expect(() => new URL(resolved)).toThrow()
    })

    it('keeps whitespace-only configuration distinguishable from unset', () => {
      // ' ' is truthy, so it is NOT treated as absent — it produces an
      // unparseable URL rather than a silent localhost fallback.
      process.env.SYNC_SERVER_URL = '   '
      expect(resolveSyncServerUrl()).toBe('   ')
      expect(() => new URL(resolveSyncServerUrl())).toThrow()
    })
  })
})
