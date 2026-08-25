import { Hono } from 'hono'
import { vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import { blob } from '../routes/blob'
import type { AppContext } from '../types'

/**
 * Shared harness for the blob route suites.
 *
 * The `vi.mock` calls must stay in each test file (they are hoisted and scoped
 * per file), but the D1/R2/session fakes below do not need duplicating — a
 * single `first()` router means a new query in blob.ts is taught to the fakes
 * once instead of drifting between two hand-maintained copies.
 */

export interface MockDbState {
  session?: Record<string, unknown> | null
  /** Row for chunk metadata reads (ref_count / size_bytes / r2_key lookups). */
  chunk?: Record<string, unknown> | null
  /**
   * Per-hash chunk rows for the dereference route, which looks up each hash in
   * a request independently (unlike the other single-row-at-a-time lookups
   * above). Keyed by hash; a missing key means "no such chunk" (route skips it).
   */
  chunksByHash?: Record<string, Record<string, unknown> | null>
  /**
   * Row for the entitlements lookup. Suites that mock ../services/entitlements
   * never reach this; the accounting suite drives the real plan limits and
   * supplies a row here.
   */
  entitlementRow?: () => Record<string, unknown> | null
  statements: Array<{ sql: string; bindings: unknown[] }>
}

const createStatement = (sql: string, state: MockDbState) => {
  const stmt = {
    bindings: [] as unknown[],
    bind: vi.fn((...args: unknown[]) => {
      stmt.bindings = args
      state.statements.push({ sql, bindings: args })
      return stmt
    }),
    first: vi.fn(async () => {
      if (sql.includes('FROM users u')) return state.entitlementRow?.() ?? null
      if (sql.includes('FROM upload_sessions')) return state.session ?? null
      if (sql.includes('SELECT id, ref_count FROM blob_chunks')) {
        const hash = stmt.bindings[2] as string | undefined
        return (hash === undefined ? undefined : state.chunksByHash?.[hash]) ?? null
      }
      if (sql.includes('FROM blob_chunks') && sql.includes('hash = ?')) {
        return state.chunk ?? null
      }
      return null
    }),
    // Batched hash lookups (presign-batch scopes by user/vault and filters by
    // `hash IN (...)`); membership in chunksByHash encodes the scoping — a
    // foreign vault's or user's hash is simply absent from the map.
    all: vi.fn(async () => {
      if (sql.includes('FROM blob_chunks') && sql.includes('hash IN (')) {
        const hashes = stmt.bindings.slice(2) as string[]
        const results = hashes
          .map((hash) => state.chunksByHash?.[hash])
          .filter((row): row is Record<string, unknown> => !!row)
        return { results }
      }
      return { results: [] }
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
  }
  return stmt
}

export const createDb = (state: MockDbState) =>
  ({
    prepare: vi.fn((sql: string) => createStatement(sql, state))
  }) as unknown as D1Database

export const createR2Object = (overrides: Record<string, unknown> = {}) => ({
  size: 5,
  body: new ReadableStream(),
  range: { offset: 1, length: 3 },
  writeHttpMetadata: vi.fn(),
  text: vi.fn().mockResolvedValue(JSON.stringify({ chunks: ['a'] })),
  ...overrides
})

const storageObject = createR2Object()

export const createStorage = () =>
  ({
    get: vi.fn().mockResolvedValue(storageObject),
    head: vi.fn().mockResolvedValue({ size: 5 }),
    put: vi.fn(),
    delete: vi.fn()
  }) as unknown as R2Bucket

export const createEnv = (state: MockDbState) => ({
  DB: createDb(state),
  STORAGE: createStorage(),
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'pk',
  JWT_PRIVATE_KEY: 'sk',
  RESEND_API_KEY: 'resend',
  GOOGLE_CLIENT_ID: 'google-client',
  // `test-` prefixed so the staged-secret scanner reads it as a placeholder: it
  // exempts *.test.ts, and this harness is not one.
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  RECOVERY_DUMMY_SECRET: 'dummy'
})

export const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('', blob)
  return app
}

/**
 * A fresh single-chunk session row as the server would have written it: 1024
 * plaintext bytes, nothing uploaded yet, `encrypted_size` unset (the derive
 * path taken by clients installed before that column existed).
 */
export const createSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  user_id: 'user-1',
  vault_id: 'vault-1',
  attachment_id: 'att-1',
  filename: 'file.bin',
  total_size: 1024,
  chunk_count: 1,
  encrypted_size: null,
  uploaded_chunks: '[]',
  expires_at: Math.floor(Date.now() / 1000) + 100,
  created_at: 1,
  ...overrides
})

export const findBinding = (state: MockDbState, sqlFragment: string) =>
  state.statements.find((s) => s.sql.includes(sqlFragment))
