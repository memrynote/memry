import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TrackMainEventOptions } from '../telemetry/track'
import { resetTelemetryThrottle } from '../telemetry/throttle'

// The module under test is the accounting; what it must NEVER do is emit
// twice, emit outside an active bootstrap, or let a telemetry failure escape
// into the sync engine. Consent gating lives in the telemetry client and is
// exercised end-to-end in bootstrap-metrics.consent.test.ts.

const mocks = vi.hoisted(() => ({
  trackMainEvent: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: (...args: unknown[]) => mocks.trackMainEvent(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.log
}))

import {
  abandonBootstrap,
  beginBootstrap,
  isBootstrapActive,
  markBootstrapFullText,
  markBootstrapInteractive,
  noteCountBucket,
  recordBootstrapBytes,
  resetBootstrapMetrics,
  setBootstrapStatsProvider,
  vaultSizeBucket
} from './bootstrap-metrics'

type EmittedEvent = { name: string; options: TrackMainEventOptions }

const emitted = (): EmittedEvent[] =>
  mocks.trackMainEvent.mock.calls.map(([name, options]) => ({
    name: name as string,
    options: options as TrackMainEventOptions
  }))

const byAction = (action: string): EmittedEvent[] =>
  emitted().filter((event) => event.options.action === action)

/** markBootstrapFullText resolves its stats provider async — let it settle. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps mock IMPLEMENTATIONS — the throwing-emitter test would
  // otherwise leak its throw into whichever test runs after it.
  mocks.trackMainEvent.mockReset()
  resetBootstrapMetrics()
  resetTelemetryThrottle()
  setBootstrapStatsProvider(async () => ({ noteCount: null, vaultSizeBytes: null }))
})

afterEach(() => {
  resetBootstrapMetrics()
  resetTelemetryThrottle()
})

describe('bucketing', () => {
  it('#given note counts #then each maps to its coarse bucket, never a raw count', () => {
    expect(noteCountBucket(0)).toBe('0-100')
    expect(noteCountBucket(99)).toBe('0-100')
    expect(noteCountBucket(100)).toBe('100-1k')
    expect(noteCountBucket(999)).toBe('100-1k')
    expect(noteCountBucket(1000)).toBe('1k-10k')
    expect(noteCountBucket(9999)).toBe('1k-10k')
    expect(noteCountBucket(10_000)).toBe('10k+')
    expect(noteCountBucket(250_000)).toBe('10k+')
  })

  it('#given vault sizes #then each maps to its coarse bucket', () => {
    const MB = 1024 * 1024
    const GB = 1024 * MB
    expect(vaultSizeBucket(0)).toBe('lt100mb')
    expect(vaultSizeBucket(100 * MB - 1)).toBe('lt100mb')
    expect(vaultSizeBucket(100 * MB)).toBe('100mb-1gb')
    expect(vaultSizeBucket(GB - 1)).toBe('100mb-1gb')
    expect(vaultSizeBucket(GB)).toBe('1gb-10gb')
    expect(vaultSizeBucket(10 * GB - 1)).toBe('1gb-10gb')
    expect(vaultSizeBucket(10 * GB)).toBe('10gb+')
  })

  it('#given unresolvable inputs #then the bucket says unknown rather than lying', () => {
    expect(noteCountBucket(Number.NaN)).toBe('unknown')
    expect(noteCountBucket(-1)).toBe('unknown')
    expect(vaultSizeBucket(Number.NaN)).toBe('unknown')
    expect(vaultSizeBucket(-5)).toBe('unknown')
  })
})

describe('#given throughput arithmetic', () => {
  // Fake ONLY the clock: the completion path settles through real microtasks,
  // so faking timers wholesale would hang the settle() helper.
  afterEach(() => {
    vi.useRealTimers()
  })

  const freezeClockAt = (): number => new Date('2026-06-01T12:00:00Z').getTime()

  it('#then value is bytes divided by elapsed seconds, rounded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(freezeClockAt())
    beginBootstrap('vault_download')
    recordBootstrapBytes('records', 900_000)
    vi.setSystemTime(freezeClockAt() + 3_000)

    markBootstrapFullText()
    await settle()

    const records = byAction('throughput').find((event) => event.options.source === 'records')
    expect(records?.options.metrics?.durationMs).toBe(3_000)
    expect(records?.options.metrics?.value).toBe(300_000)
  })

  it('#then a zero-width window divides by one millisecond, never by zero', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(freezeClockAt())
    beginBootstrap('vault_download')
    recordBootstrapBytes('crdt', 250)

    markBootstrapFullText()
    await settle()

    const crdt = byAction('throughput').find((event) => event.options.source === 'crdt')
    expect(crdt?.options.metrics?.durationMs).toBe(0)
    // Math.max(durationMs, 1)/1000 floors the divisor at 0.001s.
    expect(crdt?.options.metrics?.value).toBe(250_000)
  })
})

describe('#given no active bootstrap', () => {
  it('#then every hook no-ops and nothing is emitted', async () => {
    recordBootstrapBytes('records', 1000)
    markBootstrapInteractive()
    markBootstrapFullText()
    await settle()

    expect(isBootstrapActive()).toBe(false)
    expect(mocks.trackMainEvent).not.toHaveBeenCalled()
  })
})

describe('#given a vault-download bootstrap', () => {
  it('#then markInteractive emits exactly one interactive milestone', () => {
    beginBootstrap('vault_download')

    markBootstrapInteractive()
    markBootstrapInteractive()

    const events = byAction('interactive')
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('sync_bootstrap')
    expect(events[0].options.surface).toBe('sync')
    expect(events[0].options.source).toBe('vault_download')
    expect(events[0].options.result).toBe('success')
    expect(events[0].options.metrics?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('#then a second begin cannot restart or re-source the open window', () => {
    beginBootstrap('vault_download')
    beginBootstrap('first_full_sync')

    markBootstrapInteractive()

    expect(byAction('interactive')[0].options.source).toBe('vault_download')
  })

  it('#then full text emits the milestone plus one throughput summary per channel', async () => {
    setBootstrapStatsProvider(async () => ({
      noteCount: 4200,
      vaultSizeBytes: 250 * 1024 * 1024
    }))
    beginBootstrap('vault_download')
    recordBootstrapBytes('records', 600)
    recordBootstrapBytes('records', 400)
    recordBootstrapBytes('crdt', 2000)
    // attachments deliberately left at zero — the split must still be complete

    markBootstrapFullText()
    await settle()

    const fullText = byAction('full_text')
    expect(fullText).toHaveLength(1)
    expect(fullText[0].options.dimensions).toEqual({ note_bucket: '1k-10k' })
    expect(fullText[0].options.metrics?.durationMs).toBeGreaterThanOrEqual(0)

    const throughput = byAction('throughput')
    expect(throughput).toHaveLength(3)
    const byChannel = new Map(throughput.map((event) => [event.options.source, event.options]))
    expect(byChannel.get('records')?.metrics?.byteCount).toBe(1000)
    expect(byChannel.get('crdt')?.metrics?.byteCount).toBe(2000)
    expect(byChannel.get('attachments')?.metrics?.byteCount).toBe(0)
    for (const options of byChannel.values()) {
      expect(options.dimensions).toEqual({ size_bucket: '100mb-1gb' })
      expect(options.metrics?.value).toBeGreaterThanOrEqual(0)
      expect(options.metrics?.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('#then the window closes with full text: later bytes and repeats are dropped', async () => {
    beginBootstrap('vault_download')
    recordBootstrapBytes('crdt', 100)

    markBootstrapFullText()
    await settle()
    expect(isBootstrapActive()).toBe(false)

    recordBootstrapBytes('crdt', 999_999)
    markBootstrapFullText()
    await settle()

    expect(byAction('full_text')).toHaveLength(1)
    expect(byAction('throughput')).toHaveLength(3)
  })

  it('#then a failing stats provider degrades to unknown buckets, never to silence', async () => {
    setBootstrapStatsProvider(async () => {
      throw new Error('index db is gone')
    })
    beginBootstrap('vault_download')

    markBootstrapFullText()
    await settle()

    expect(byAction('full_text')[0].options.dimensions).toEqual({ note_bucket: 'unknown' })
    expect(byAction('throughput')[0].options.dimensions).toEqual({ size_bucket: 'unknown' })
  })

  it('#then an abandoned window emits nothing at all', async () => {
    beginBootstrap('vault_download')
    recordBootstrapBytes('records', 500)

    abandonBootstrap()
    markBootstrapInteractive()
    markBootstrapFullText()
    await settle()

    expect(mocks.trackMainEvent).not.toHaveBeenCalled()
  })
})

describe('#given telemetry itself misbehaves', () => {
  it('#then a throwing emitter never escapes into the caller', () => {
    mocks.trackMainEvent.mockImplementation(() => {
      throw new Error('posthog exploded')
    })
    beginBootstrap('vault_download')

    expect(() => markBootstrapInteractive()).not.toThrow()
    expect(() => markBootstrapFullText()).not.toThrow()
    expect(() => recordBootstrapBytes('records', 1)).not.toThrow()
  })
})

describe('#given back-to-back bootstraps inside one minute', () => {
  it('#then the per-minute throttle holds each action to a single emission', async () => {
    beginBootstrap('vault_download')
    markBootstrapInteractive()
    markBootstrapFullText()
    await settle()

    // A second window opening seconds later (two vault downloads in one
    // session) must not double the events — same discipline as the per-minute
    // IPC error throttle.
    beginBootstrap('vault_download')
    markBootstrapInteractive()
    markBootstrapFullText()
    await settle()

    expect(byAction('interactive')).toHaveLength(1)
    expect(byAction('full_text')).toHaveLength(1)
    expect(byAction('throughput')).toHaveLength(3)
  })
})
