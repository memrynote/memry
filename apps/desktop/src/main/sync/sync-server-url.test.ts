import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveSyncServerUrl } from './sync-server-url'

const ORIGINAL_URL = process.env.SYNC_SERVER_URL
const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const DEV_FALLBACK = 'http://localhost:8787'

function setEnvUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.SYNC_SERVER_URL
  else process.env.SYNC_SERVER_URL = value
}

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = value
}

describe('resolveSyncServerUrl', () => {
  beforeEach(() => {
    setEnvUrl(undefined)
    // Vitest already runs as 'test', but pin it so the fallback branch under
    // test does not depend on the runner's ambient value.
    setNodeEnv('development')
  })

  afterEach(() => {
    setEnvUrl(ORIGINAL_URL)
    setNodeEnv(ORIGINAL_NODE_ENV)
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

    it('also falls back under the test harness, which runs an unpackaged build', () => {
      // vitest and tests/e2e/utils/electron-lifecycle.ts both launch with
      // NODE_ENV=test and frequently without SYNC_SERVER_URL. Throwing there
      // would break a currently-green harness without making a shipped build
      // any safer.
      setNodeEnv('test')
      expect(resolveSyncServerUrl()).toBe(DEV_FALLBACK)
    })
  })

  describe('production policy', () => {
    // The defect this guard closes: one env var had two policies. http-client.ts
    // already threw outside development, so a packaged app with a missing or
    // corrupt Resources/app-config failed sync HTTP loudly — while THIS resolver
    // handed the OAuth sign-in URL (ipc/auth-oauth-handlers.ts) and the canvas
    // asset service (canvas/assets/asset-service-context.ts) a silent
    // http://localhost:8787, pointing a real user at a port nothing is on.

    it('refuses to fall back to localhost when NODE_ENV is production', () => {
      setNodeEnv('production')
      expect(() => resolveSyncServerUrl()).toThrow(
        'SYNC_SERVER_URL environment variable is not configured'
      )
    })

    it('refuses to fall back when NODE_ENV is unset, as it is in packaged Electron', () => {
      // Packaged builds leave NODE_ENV undefined at runtime — see the
      // applyPackagedLogLevels comment in src/main/index.ts. That is precisely
      // the case that used to silently resolve to localhost.
      setNodeEnv(undefined)
      expect(() => resolveSyncServerUrl()).toThrow(
        'SYNC_SERVER_URL environment variable is not configured'
      )
    })

    it('raises the same message http-client.ts raises, so one policy has one error', () => {
      setNodeEnv(undefined)
      expect(() => resolveSyncServerUrl()).toThrow(
        new Error('SYNC_SERVER_URL environment variable is not configured')
      )
    })

    it('never throws for a correctly packaged build, which always ships a configured URL', () => {
      // scripts/build-packaged-app.js refuses to package without
      // apps/desktop/.env.production and asserts the value is a non-local HTTPS
      // URL, then stages it as Resources/app-config. So production reaching the
      // throw means the config is genuinely gone, not that this guard is strict.
      setNodeEnv('production')
      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com'
      expect(resolveSyncServerUrl()).toBe('https://sync.memrynote.com')
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

    it('strips a trailing slash so callers never build a double-slash path', () => {
      // Callers build paths with `${url}/auth/...`. Left un-normalized, a
      // trailing slash in the env produced `https://host//auth/...`, which the
      // Cloudflare Worker routes as a different path — so sign-in 404s against
      // an otherwise correct configuration.
      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com/'
      expect(resolveSyncServerUrl()).toBe('https://sync.memrynote.com')
      expect(`${resolveSyncServerUrl()}/auth/oauth/google`).toBe(
        'https://sync.memrynote.com/auth/oauth/google'
      )
    })

    it('strips repeated trailing slashes and leaves a base path intact', () => {
      process.env.SYNC_SERVER_URL = 'https://sync.memrynote.com///'
      expect(resolveSyncServerUrl()).toBe('https://sync.memrynote.com')

      process.env.SYNC_SERVER_URL = 'https://edge.example.com/memry/'
      expect(resolveSyncServerUrl()).toBe('https://edge.example.com/memry')
    })

    it('leaves an all-slashes value alone rather than collapsing it to an empty string', () => {
      // Degenerate, but returning '' would silently turn every absolute call
      // into a relative path instead of failing at the call site.
      process.env.SYNC_SERVER_URL = '/'
      expect(resolveSyncServerUrl()).toBe('/')
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
