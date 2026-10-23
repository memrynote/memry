/**
 * D12: the three Readwise events leave through the real telemetry runtime and
 * client, so the contract allowlist and the payload schema both apply. A name
 * missing from the allowlist, or a payload outside the schema, is dropped
 * before the batch and the test sees no event.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { mockApp } from '@tests/utils/mock-electron'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { TelemetryBatchSchema, type TelemetryEvent } from '@memry/contracts/telemetry-api'
import type { DataDb } from '../database/types'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({ getDatabase: () => currentDb }))
vi.mock('../vault', () => ({ getStatus: () => ({ path: '/vaults/a' }) }))
vi.mock('electron', () => ({ app: mockApp, net: { isOnline: () => true } }))

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}/${a}`, v)),
  getSecret: vi.fn(async (s: string, a: string) => secrets.get(`${s}/${a}`) ?? null),
  deleteSecret: vi.fn(async (s: string, a: string) => void secrets.delete(`${s}/${a}`))
}))

import { disposeTelemetryRuntime, initializeTelemetryRuntime } from '../telemetry/runtime'
import { connectReadwise, disconnectReadwise } from './connection'
import { ReadwiseScheduler } from './runtime-effects'
import { setReadwiseToken } from './secrets'
import { setCursor } from './sync-state'
import type { ReadwiseSyncService, RunResult } from './sync-service'

beforeAll(async () => {
  await sodium.ready
})

const TOKEN = 'tok-never-in-telemetry'

const emptyRun: RunResult = {
  cancelled: false,
  books: 4,
  added: 2,
  updated: 1,
  appended: 1,
  deferred: 0,
  failed: 0,
  documents: 3,
  highlights: 17
}

describe('Readwise telemetry', () => {
  let tempDir: string
  let result: TestDatabaseResult
  let batches: string[]

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-readwise-telemetry-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
    batches = []
    initializeTelemetryRuntime({
      fetch: async (_url, init) => {
        batches.push(String(init?.body))
        return { ok: true, status: 202 }
      },
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true,
      flushIntervalMs: null
    })
  })

  afterEach(async () => {
    await disposeTelemetryRuntime()
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** What left the device, other than the launch event. */
  async function shipped(): Promise<{ events: TelemetryEvent[]; raw: string }> {
    const { getTelemetryRuntime } = await import('../telemetry/runtime')
    await getTelemetryRuntime()!.flush('manual')
    // The sync server validates the whole batch against this schema, so one name
    // outside the allowlist would drop every event that rides with it.
    const parsed = batches.map((body) => TelemetryBatchSchema.parse(JSON.parse(body)))
    const events = parsed
      .flatMap((batch) => batch.events)
      .filter((event) => event.name.startsWith('readwise_'))
    return { events, raw: batches.join('\n') }
  }

  it('sends readwise_connected on a successful connect, with no token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )

    await connectReadwise(TOKEN)

    const { events, raw } = await shipped()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'readwise_connected',
      surface: 'vault',
      source: 'token',
      result: 'success'
    })
    expect(raw).not.toContain(TOKEN)
  })

  it('sends readwise_connected with the failure code when the token is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    )

    await expect(connectReadwise(TOKEN)).rejects.toThrow(
      'Readwise did not accept this token. Copy it again from readwise.io/access_token.'
    )

    const { events, raw } = await shipped()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'readwise_connected',
      result: 'failed',
      errorCode: 'invalid-token'
    })
    expect(raw).not.toContain(TOKEN)
  })

  it('sends readwise_disconnected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    await connectReadwise(TOKEN)

    await disconnectReadwise()

    const { events } = await shipped()
    expect(events.map((event) => event.name)).toEqual([
      'readwise_connected',
      'readwise_disconnected'
    ])
  })

  describe('sync runs', () => {
    let clock: number
    const schedulerFor = (run: () => Promise<RunResult>) =>
      new ReadwiseScheduler({
        now: () => clock,
        isOnline: () => true,
        canPull: () => true,
        getService: () =>
          ({
            isRunning: false,
            run: async () => {
              clock += 1_250
              return await run()
            }
          }) as unknown as ReadwiseSyncService
      })

    beforeEach(async () => {
      clock = 1_000_000
      await setReadwiseToken('/vaults/a', TOKEN)
      setCursor(currentDb!, '2026-10-22T09:00:00.000Z')
    })

    it('sends counts and the duration, and nothing that names a book', async () => {
      await schedulerFor(async () => emptyRun).syncNow()

      const { events, raw } = await shipped()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        name: 'readwise_sync_completed',
        source: 'manual',
        result: 'success',
        metrics: { durationMs: 1250, itemCount: 7, resultCount: 17, value: 0 }
      })
      expect(Object.keys(events[0]).sort()).toEqual(
        ['action', 'id', 'metrics', 'name', 'occurredAt', 'result', 'source', 'surface'].sort()
      )
      expect(raw).not.toContain(TOKEN)
    })

    it('reports a run with failed books as failed, with the count', async () => {
      await schedulerFor(async () => ({ ...emptyRun, failed: 2 })).syncNow()

      const { events } = await shipped()
      expect(events[0]).toMatchObject({ result: 'failed', metrics: { value: 2 } })
    })

    it('sends only the error code when a run fails', async () => {
      const { ReadwiseError } = await import('./client')
      const scheduler = schedulerFor(async () => {
        throw new ReadwiseError('rate-limited', 'https://readwise.io/api/v2/export/?secret=1')
      })

      await expect(scheduler.syncNow()).rejects.toThrow(
        'https://readwise.io/api/v2/export/?secret=1'
      )

      const { events, raw } = await shipped()
      expect(events[0]).toMatchObject({
        name: 'readwise_sync_completed',
        result: 'failed',
        errorCode: 'rate-limited'
      })
      expect(raw).not.toContain('secret=1')
    })
  })
})
