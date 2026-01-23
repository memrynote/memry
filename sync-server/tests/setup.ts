/**
 * Sync Server Test Setup
 *
 * Global setup for sync-server unit tests.
 * Mocks Cloudflare Workers runtime and provides test utilities.
 */

import { beforeEach, afterEach, vi } from 'vitest'
import type { D1Database, R2Bucket, DurableObjectNamespace } from '@cloudflare/workers-types'

// Mock crypto.randomUUID for consistent testing
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: () => '12345678-1234-1234-1234-123456789abc'
  }
})

// Mock Date.now for consistent timestamps
const mockNow = 1704067200000 // 2024-01-01 00:00:00 UTC

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(mockNow)
})

afterEach(() => {
  vi.useRealTimers()
})

// Mock fetch for HTTP requests
global.fetch = vi.fn()

// Export common test utilities
export const createMockEnv = () => ({
  DB: {} as D1Database,
  BUCKET: {} as R2Bucket,
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  JWT_SECRET: 'test-jwt-secret',
  RESEND_API_KEY: 'test-resend-key',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  EMAIL_FROM: 'test@example.com',
  EMAIL_FROM_NAME: 'Test App'
})

// Mock D1Database methods
export const createMockD1Database = (): D1Database => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } })
  }),
  dump: vi.fn(),
  batch: vi.fn(),
  exec: vi.fn(),
  withSession: vi.fn()
})
