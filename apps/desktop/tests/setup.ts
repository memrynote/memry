/**
 * Global test setup file.
 * Runs before all tests in all workspaces.
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest'

// ============================================================================
// Global Mocks
// ============================================================================

// Make Testing Library's fake-timer detection work with Vitest.
const globalWithJest = globalThis as typeof globalThis & { jest?: typeof vi }
if (!globalWithJest.jest) {
  globalWithJest.jest = vi
}

// Block real OS keychain access from tests. Unmocked transitive imports of keytar
// (e.g. local-sync-effects → isMemryUserSignedIn → retrieveKey) otherwise read the
// real 'com.memry.sync' items, triggering macOS "node wants to use your confidential
// information" prompts on every suite run. Per-file vi.mock('keytar', ...) factories
// still take precedence. The env check must live inside the factory: vi.mock calls
// are hoisted, so an `if` around the call is bypassed. KEYCHAIN_E2E=1 opts back into
// the real keychain for keychain.e2e.test.ts, which roundtrips 'com.memry.sync.test'.
vi.mock('keytar', async (importOriginal) => {
  if (process.env.KEYCHAIN_E2E === '1') return importOriginal()
  return {
    default: {
      getPassword: vi.fn(async () => null),
      setPassword: vi.fn(async () => undefined),
      deletePassword: vi.fn(async () => false),
      findPassword: vi.fn(async () => null),
      findCredentials: vi.fn(async () => [])
    }
  }
})

// Mock crypto.randomUUID for consistent IDs in tests
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256)
        }
        return arr
      }
    }
  })
}

// ============================================================================
// Lifecycle Hooks
// ============================================================================

beforeAll(() => {
  // Setup before all tests in a file
})

afterEach(() => {
  // Clear all mocks after each test
  vi.clearAllMocks()
})

afterAll(() => {
  // Cleanup after all tests in a file
  vi.restoreAllMocks()
})

// ============================================================================
// Global Test Utilities
// ============================================================================

/**
 * Wait for a specified duration.
 * Useful for testing async operations.
 */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Create a deferred promise for testing async behavior.
 */
export function createDeferred<T>() {
  let resolve: (value: T) => void
  let reject: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve: resolve!, reject: reject! }
}

/**
 * Generate a test ID with optional prefix.
 */
export const testId = (prefix = 'test'): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
