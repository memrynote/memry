/**
 * The Readwise status the panel, the row and the error toast read (#1418),
 * through the real status body, scheduler, run engine and data DB, with only
 * readwise.io stubbed. The account is empty, so a run reads the export and writes nothing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { markSyncIneligible, resetSyncDecision } from '@memry/sync-client/sync-eligibility'
import sodium from 'libsodium-wrappers-sumo'
import { ReadwiseStub } from '@tests/utils/readwise-stub'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database/types'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({ getDatabase: () => currentDb }))
vi.mock('../vault', () => ({ getStatus: () => ({ path: '/vaults/a' }) }))
vi.mock('electron', () => ({ net: { isOnline: () => true } }))
vi.mock('../sync/runtime', () => ({ getSyncEngine: () => ({ currentState: 'idle' }) }))
vi.mock('../vault/activity-log', () => ({ recordActivity: vi.fn() }))

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}/${a}`, v)),
  getSecret: vi.fn(async (s: string, a: string) => secrets.get(`${s}/${a}`) ?? null),
  deleteSecret: vi.fn(async (s: string, a: string) => void secrets.delete(`${s}/${a}`))
}))

import { setReadwiseToken } from './secrets'
import { setCursor, claimErrorToast } from './sync-state'
import { clearRunFailure, classifyRunFailure } from './run-status'
import { stopReadwiseScheduler } from './runtime-effects'
import { connectReadwise, getReadwiseStatus, syncReadwiseNow } from './connection'
import { ReadwiseError } from './client'
import { ReadwisePullGateError } from './pull-gate'

beforeAll(async () => {
  await sodium.ready
})

describe('Readwise status (#1418)', () => {
  let result: TestDatabaseResult
  let readwise: ReadwiseStub
  const db = () => currentDb as DataDb

  beforeEach(async () => {
    markSyncIneligible()
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
    readwise = new ReadwiseStub()
    vi.stubGlobal('fetch', vi.fn(readwise.handle))
    await setReadwiseToken('/vaults/a', 'tok-status')
    setCursor(db(), '2026-10-22T09:00:00.000Z')
  })

  afterEach(() => {
    resetSyncDecision()
    stopReadwiseScheduler()
    clearRunFailure()
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
  })

  it('a healthy run shows the last run and no error', async () => {
    await syncReadwiseNow()
    const status = await getReadwiseStatus()
    expect(status).toMatchObject({
      connected: true,
      syncing: null,
      error: null,
      lastRun: { books: 0, added: 0, highlights: 0 }
    })
    expect(status.lastSyncAt).not.toBeNull()
    // A run that fixed nothing has no toast to show.
    expect(claimErrorToast(db())).toBe(false)
  })

  it('a revoked token shows one toast across failed runs, and a new one only after it was fixed and came back', async () => {
    readwise.failWhen = () => 401
    await expect(syncReadwiseNow()).rejects.toThrow(
      'Readwise did not accept this token. Copy it again from readwise.io/access_token.'
    )
    expect((await getReadwiseStatus()).error).toEqual({ kind: 'invalid-token', detail: null })
    expect(claimErrorToast(db())).toBe(true)

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(syncReadwiseNow()).rejects.toThrow(
        'Readwise did not accept this token. Copy it again from readwise.io/access_token.'
      )
      expect(claimErrorToast(db())).toBe(false)
    }

    // The user pastes a fresh token: the error is fixed.
    readwise.failWhen = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/api/v2/auth/'
          ? new Response(null, { status: 204 })
          : readwise.handle(input)
      )
    )
    await connectReadwise('fresh-token')
    expect((await getReadwiseStatus()).error).toBeNull()
    expect(claimErrorToast(db())).toBe(false)

    // It comes back: a new episode, a new toast.
    readwise.failWhen = () => 401
    await expect(syncReadwiseNow()).rejects.toThrow(
      'Readwise did not accept this token. Copy it again from readwise.io/access_token.'
    )
    expect(claimErrorToast(db())).toBe(true)
  })

  it('an expired subscription is an error the user must fix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Your subscription has expired.' }), {
            status: 403
          })
      )
    )
    await expect(syncReadwiseNow()).rejects.toThrow(
      'Could not reach Readwise. Check your connection and try again.'
    )
    expect((await getReadwiseStatus()).error).toEqual({
      kind: 'subscription-expired',
      detail: null
    })
    expect(claimErrorToast(db())).toBe(true)
  })

  it('a network error shows in the status with the next try, and never asks for a toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      })
    )
    await expect(syncReadwiseNow()).rejects.toThrow(
      'Could not reach Readwise. Check your connection and try again.'
    )
    const status = await getReadwiseStatus()
    expect(status.error).toEqual({ kind: 'network', detail: null })
    expect(status.nextRunAt).not.toBeNull()
    expect(claimErrorToast(db())).toBe(false)

    // A later good run clears it.
    vi.stubGlobal('fetch', vi.fn(readwise.handle))
    await syncReadwiseNow()
    expect((await getReadwiseStatus()).error).toBeNull()
  })

  it('names each failure by kind, and treats a pull-gate refusal as a state, not a failure', () => {
    expect(classifyRunFailure(new ReadwiseError('rate-limited', 'x'))).toEqual({
      kind: 'rate-limited',
      detail: null
    })
    expect(classifyRunFailure(new ReadwiseError('server', 'x'))?.kind).toBe('server')
    expect(classifyRunFailure(new Error('disk gone'))).toEqual({
      kind: 'unexpected',
      detail: 'disk gone'
    })
    expect(classifyRunFailure(new ReadwisePullGateError('needs-sync'))).toBeNull()
  })
})
