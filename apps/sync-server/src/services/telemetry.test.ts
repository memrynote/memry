import { describe, expect, it, vi } from 'vitest'

import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

import { hashTelemetryId, writeTelemetryBatch } from './telemetry'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001'
const VALID_EVENT_ID = '550e8400-e29b-41d4-a716-446655440002'
const VALID_TIMESTAMP = '2026-05-01T12:00:00.000Z'
const HMAC_KEY = 'test-telemetry-hmac-key'

const baseBatch: TelemetryBatch = {
  schemaVersion: 1,
  installId: VALID_INSTALL_ID,
  sessionId: VALID_SESSION_ID,
  appVersion: '0.1.0',
  buildChannel: 'development',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'en',
  timezoneOffsetMinutes: -180,
  authState: 'anonymous',
  syncState: 'disabled',
  events: [
    {
      id: VALID_EVENT_ID,
      name: 'app_started',
      occurredAt: VALID_TIMESTAMP,
      surface: 'app',
      action: 'started',
      result: 'success'
    }
  ]
}

type WriteCall = {
  blobs?: string[]
  doubles?: number[]
  indexes?: string[]
}

function createDataset(): { dataset: AnalyticsEngineDataset; calls: WriteCall[] } {
  const calls: WriteCall[] = []
  const dataset: AnalyticsEngineDataset = {
    writeDataPoint: vi.fn((point: AnalyticsEngineDataPoint) => {
      calls.push({
        blobs: point.blobs ? [...(point.blobs as string[])] : undefined,
        doubles: point.doubles ? [...(point.doubles as number[])] : undefined,
        indexes: point.indexes ? [...(point.indexes as string[])] : undefined
      })
    })
  } as unknown as AnalyticsEngineDataset
  return { dataset, calls }
}

function createEnv(dataset: AnalyticsEngineDataset, hmacKey = HMAC_KEY) {
  return {
    PRODUCT_TELEMETRY: dataset,
    TELEMETRY_HMAC_KEY: hmacKey
  } as unknown as {
    PRODUCT_TELEMETRY: AnalyticsEngineDataset
    TELEMETRY_HMAC_KEY: string
  }
}

describe('hashTelemetryId', () => {
  it('returns a stable hex HMAC for the same input', async () => {
    // #given a fixed key and id
    const a = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)
    const b = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)

    // #then both calls produce the same hex string
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a.length).toBe(64) // SHA-256 hex
  })

  it('returns different hashes for different ids', async () => {
    // #given two distinct ids
    const a = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)
    const b = await hashTelemetryId(HMAC_KEY, VALID_SESSION_ID)

    // #then their hashes differ
    expect(a).not.toBe(b)
  })

  it('never returns the raw id', async () => {
    // #given an id and a key
    const hash = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)

    // #then the hash does not contain the raw uuid
    expect(hash.includes(VALID_INSTALL_ID)).toBe(false)
  })

  it('throws when the key is empty', async () => {
    // #given an empty hmac key
    // #when hashing
    // #then it rejects
    await expect(hashTelemetryId('', VALID_INSTALL_ID)).rejects.toThrow()
  })
})

describe('writeTelemetryBatch', () => {
  it('writes one datapoint per event', async () => {
    // #given a batch with two events
    const { dataset, calls } = createDataset()
    const batch: TelemetryBatch = {
      ...baseBatch,
      events: [
        baseBatch.events[0],
        {
          ...baseBatch.events[0],
          id: '550e8400-e29b-41d4-a716-446655440099',
          name: 'page_viewed',
          surface: 'notes',
          action: 'viewed'
        }
      ]
    }

    // #when writing
    const result = await writeTelemetryBatch(createEnv(dataset), batch)

    // #then both events are accepted as datapoints
    expect(result.accepted).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('uses the install hash as index1 and never the raw install id', async () => {
    // #given a single-event batch
    const { dataset, calls } = createDataset()
    const installHash = await hashTelemetryId(HMAC_KEY, VALID_INSTALL_ID)

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), baseBatch)

    // #then the index slot holds only the hash, not the raw id
    expect(calls[0].indexes).toEqual([installHash])
    expect(calls[0].indexes?.[0]).not.toBe(VALID_INSTALL_ID)
  })

  it('writes blob slots in the documented order', async () => {
    // #given a batch with rich event metadata
    const { dataset, calls } = createDataset()
    const sessionHash = await hashTelemetryId(HMAC_KEY, VALID_SESSION_ID)
    const batch: TelemetryBatch = {
      ...baseBatch,
      events: [
        {
          ...baseBatch.events[0],
          objectType: 'note',
          source: 'sidebar',
          errorCode: 'sync_replay',
          dimensions: { capture_type: 'text' }
        }
      ]
    }

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), batch)

    // #then blob slots match the design mapping
    const blobs = calls[0].blobs ?? []
    expect(blobs[0]).toBe('app_started') // event_name
    expect(blobs[1]).toBe('1') // schema_version
    expect(blobs[2]).toBe('0.1.0') // app_version
    expect(blobs[3]).toBe('development') // build_channel
    expect(blobs[4]).toBe('darwin') // platform
    expect(blobs[5]).toBe('arm64') // arch
    expect(blobs[6]).toBe('en') // locale
    expect(blobs[7]).toMatch(/^UTC[+-]\d+$/) // timezone_bucket
    expect(blobs[8]).toBe('anonymous') // auth_state
    expect(blobs[9]).toBe('disabled') // sync_state
    expect(blobs[10]).toBe('app') // surface
    expect(blobs[11]).toBe('started') // action
    expect(blobs[12]).toBe('note') // object_type
    expect(blobs[13]).toBe('sidebar') // source
    expect(blobs[14]).toBe('success') // result
    expect(blobs[15]).toBe('sync_replay') // error_code
    expect(blobs[16]).toBe('capture_type') // dimension_key
    expect(blobs[17]).toBe('text') // dimension_value
    expect(blobs[18]).toBe(sessionHash) // session_hash
    expect(blobs[19]).toBe('') // reserved
    expect(blobs).toHaveLength(20)
  })

  it('defaults missing numeric metric slots to zero', async () => {
    // #given a single-event batch with no metrics and no clientQueueDepth
    const { dataset, calls } = createDataset()

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), baseBatch)

    // #then optional metric slots default to 0 while structural slots stay populated
    const doubles = calls[0].doubles ?? []
    expect(doubles).toHaveLength(13)
    expect(doubles[0]).toBe(1) // event_count
    expect(doubles[1]).toBe(0) // duration_ms (missing)
    expect(doubles[2]).toBe(0) // item_count (missing)
    expect(doubles[3]).toBe(0) // byte_count (missing)
    expect(doubles[4]).toBe(0) // queue_count (missing)
    expect(doubles[5]).toBe(0) // result_count (missing)
    expect(doubles[6]).toBe(0) // error_count (no errorCode)
    expect(doubles[7]).toBe(0) // retry_count (missing)
    expect(doubles[8]).toBe(0) // active_seconds (missing)
    expect(doubles[9]).toBe(0) // value (missing)
    expect(doubles[10]).toBe(1) // batch_size (one event)
    expect(doubles[11]).toBe(0) // client_queue_depth (missing)
    expect(doubles[12]).toBe(0) // reserved
  })

  it('writes provided numeric metrics into the documented double slots', async () => {
    // #given a batch with full metric coverage
    const { dataset, calls } = createDataset()
    const batch: TelemetryBatch = {
      ...baseBatch,
      clientQueueDepth: 17,
      events: [
        {
          ...baseBatch.events[0],
          metrics: {
            durationMs: 250,
            itemCount: 5,
            byteCount: 1024,
            queueCount: 3,
            resultCount: 10,
            retryCount: 2,
            activeSeconds: 60,
            value: 1.5
          }
        }
      ]
    }

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), batch)

    // #then doubles slots map metrics to their documented positions
    const doubles = calls[0].doubles ?? []
    expect(doubles[0]).toBe(1) // event_count
    expect(doubles[1]).toBe(250) // duration_ms
    expect(doubles[2]).toBe(5) // item_count
    expect(doubles[3]).toBe(1024) // byte_count
    expect(doubles[4]).toBe(3) // queue_count
    expect(doubles[5]).toBe(10) // result_count
    expect(doubles[6]).toBe(0) // error_count (no errorCode set)
    expect(doubles[7]).toBe(2) // retry_count
    expect(doubles[8]).toBe(60) // active_seconds
    expect(doubles[9]).toBe(1.5) // value
    expect(doubles[10]).toBe(1) // batch_size (one event)
    expect(doubles[11]).toBe(17) // client_queue_depth
    expect(doubles[12]).toBe(0) // reserved
  })

  it('counts errors when an errorCode is present', async () => {
    // #given an event with an errorCode
    const { dataset, calls } = createDataset()
    const batch: TelemetryBatch = {
      ...baseBatch,
      events: [
        {
          ...baseBatch.events[0],
          name: 'sync_error',
          surface: 'sync',
          errorCode: 'replay'
        }
      ]
    }

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), batch)

    // #then error_count slot is 1
    const doubles = calls[0].doubles ?? []
    expect(doubles[6]).toBe(1)
  })

  it('does not include _sample_interval in the writeDataPoint call', async () => {
    // #given a single event
    const { dataset, calls } = createDataset()

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), baseBatch)

    // #then the recorded call has only blobs/doubles/indexes
    expect(Object.keys(calls[0]).sort()).toEqual(['blobs', 'doubles', 'indexes'])
  })

  it('never writes the raw install id, session id, or hmac key into blobs', async () => {
    // #given a batch
    const { dataset, calls } = createDataset()

    // #when writing
    await writeTelemetryBatch(createEnv(dataset), baseBatch)

    // #then no blob contains a raw identifier or the secret
    const blobsJoined = (calls[0].blobs ?? []).join('|')
    expect(blobsJoined.includes(VALID_INSTALL_ID)).toBe(false)
    expect(blobsJoined.includes(VALID_SESSION_ID)).toBe(false)
    expect(blobsJoined.includes(HMAC_KEY)).toBe(false)
  })
})
