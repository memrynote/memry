import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: mocks.invoke,
    sendSync: mocks.sendSync
  }
}))

import {
  LOCALE_STORAGE_KEY,
  applyStartupLocale,
  cacheStartupLocale,
  getStartupLocaleSync,
  refreshStartupLocaleCache
} from './startup-locale'

function createStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value)
  }
}

const documentElement = { attrs: new Map<string, string>() }
const fakeDocument = {
  get documentElement() {
    return {
      setAttribute: (name: string, value: string) => documentElement.attrs.set(name, value)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  documentElement.attrs.clear()
  // The preload suite runs on `environment: 'node'`, and renderer suites never
  // clear localStorage between files. A fresh store per test keeps a cached
  // locale from leaking either way.
  vi.stubGlobal('window', { localStorage: createStorage(), addEventListener: vi.fn() })
  vi.stubGlobal('document', fakeDocument)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getStartupLocaleSync', () => {
  it('returns a cached locale without touching IPC', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr')

    expect(getStartupLocaleSync()).toBe('tr')
    expect(mocks.sendSync).not.toHaveBeenCalled()
  })

  it('falls back to synchronous IPC and caches the answer when nothing is cached', () => {
    mocks.sendSync.mockReturnValue('ar')

    expect(getStartupLocaleSync()).toBe('ar')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ar')
  })

  it('ignores a cached value that is not a supported locale', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, '[object Object]')
    mocks.sendSync.mockReturnValue('de')

    expect(getStartupLocaleSync()).toBe('de')
  })

  it('falls back to English when neither the cache nor IPC answers', () => {
    mocks.sendSync.mockReturnValue(undefined)

    expect(getStartupLocaleSync()).toBe('en')
  })

  it('falls back to English when the sync channel throws', () => {
    mocks.sendSync.mockImplementation(() => {
      throw new Error('no handler registered')
    })

    expect(getStartupLocaleSync()).toBe('en')
  })
})

describe('cacheStartupLocale', () => {
  it('survives storage that refuses writes', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded')
        }
      }
    })

    expect(() => cacheStartupLocale('fr')).not.toThrow()
  })
})

describe('refreshStartupLocaleCache', () => {
  it('rewrites a stale cache from the authoritative locale', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    mocks.invoke.mockResolvedValue('he')

    refreshStartupLocaleCache()
    await vi.waitFor(() => expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('he'))
  })

  it('leaves the cache alone when the authority cannot be read', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr')
    mocks.invoke.mockRejectedValue(new Error('offline'))

    refreshStartupLocaleCache()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr')
  })
})

describe('applyStartupLocale', () => {
  it('sets rtl for Arabic', () => {
    applyStartupLocale('ar')

    expect(documentElement.attrs.get('lang')).toBe('ar')
    expect(documentElement.attrs.get('dir')).toBe('rtl')
  })

  it('sets ltr for Turkish', () => {
    applyStartupLocale('tr')

    expect(documentElement.attrs.get('lang')).toBe('tr')
    expect(documentElement.attrs.get('dir')).toBe('ltr')
  })
})
