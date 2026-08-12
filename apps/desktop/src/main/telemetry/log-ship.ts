// Redacting electron-log transport (Path A). Intercepts every main-process
// log.warn/log.error record, redacts message + structured fields via the shared
// redaction module, feeds a ring buffer (Path B: incident snapshots), and
// batches+ships redacted lines to /telemetry/logs. Nothing in this module wires
// itself into the real logger at startup — see the caller for that (installLogShip
// is invoked once from main startup).
import log from 'electron-log'
import { net } from 'electron'

import { redactLogLine } from '@memry/contracts/redact'
import type { DiagnosticLogBatch, DiagnosticLogLine } from '@memry/contracts/diagnostics-api'
import type { TelemetryBuildChannel } from '@memry/contracts/telemetry-api'

import { getCurrentVaultPath } from '../store'
import type { TelemetryFetch } from './client'
import { getOrCreateDiagnosticsSalt, makeSaltedHasher } from './diagnostics-salt'
import { getTelemetryRuntime } from './runtime'
import { createShipQueue, type ShipQueue } from './ship-queue'

// Scopes that belong to this pipeline itself. Without this guard a flush failure
// (logged via createLogger('LogShip').warn(...) in ship-queue.ts) would be
// re-ingested by this same transport, redacted, enqueued, and potentially fail to
// flush again — an unbounded loop. 'Telemetry'/'TelemetryQueueStore' are the
// sibling telemetry scopes with the same recursion risk.
const SKIP_SCOPES = new Set(['LogShip', 'Telemetry', 'TelemetryQueueStore'])

const RING_LIMIT = 200
const RING_MS = 5 * 60 * 1000
const THROTTLE_WINDOW_MS = 3000
const THROTTLE_MAX_KEYS = 500
const DEFAULT_LEVEL = 'warn'
const DEFAULT_FLUSH_INTERVAL_MS = 30_000

const LEVEL_ORDER: Record<string, number> = {
  error: 50,
  warn: 40,
  info: 30,
  verbose: 20,
  debug: 10,
  silly: 0
}

export type RawLogRecord = { level: string; scope?: string; data: unknown[]; date?: string }

export const parseRecord = (
  r: RawLogRecord
): { level: 'warn' | 'error'; scope: string; message: string; fields: Record<string, unknown> } => {
  const level = r.level === 'error' ? 'error' : 'warn'
  const scope = r.scope || 'app'
  let message = ''
  const fields: Record<string, unknown> = {}
  for (const arg of r.data) {
    if (typeof arg === 'string' && !message) message = arg
    else if (arg instanceof Error) {
      if (!message)
        message = typeof arg.message === 'string' && arg.message ? arg.message : arg.name
      fields.errorName = arg.name
      // A leading label (logger.error('updater error', err)) claims the message slot,
      // which used to leave the Error itself reduced to `{"errorName":"Error"}` —
      // no message, nothing to diagnose (#842). Keep it as a field instead.
      if (typeof arg.message === 'string' && arg.message && !('errorMessage' in fields))
        fields.errorMessage = arg.message
    } else if (arg && typeof arg === 'object') Object.assign(fields, arg)
    else if (!message) message = String(arg)
  }
  return { level, scope, message, fields }
}

export interface LogShipDeps {
  /** Controls the ship-vs-ring-only gate: dev builds never ship, only ring-fill. */
  buildChannel: TelemetryBuildChannel
  /** Injectable for tests; defaults to electron's net.fetch. */
  fetch?: TelemetryFetch
  endpoint?: string
  /** Injectable for tests; defaults to the persisted per-install diagnostics salt. */
  salt?: string
  /** Overrides MEMRY_DIAG_LOG_LEVEL; effective floor is always clamped to >= warn. */
  level?: string
  /** null disables the periodic flush timer (tests drive flush via dispose()). */
  flushIntervalMs?: number | null
  /** Absolute path of the log queue's crash-durable mirror; omitted → memory only. */
  persistPath?: string
}

export interface LogShip {
  dispose(): Promise<void>
  ingestForwarded(record: RawLogRecord, workerName: string): void
  recentLines(): DiagnosticLogLine[]
}

let logShipInstance: LogShip | null = null

type RawTransportMessage = { data: unknown[]; level: string; scope?: string }
type RawTransportFn = ((message: RawTransportMessage) => void) & { level: string }
type MutableTransports = Record<string, RawTransportFn | null>

const resolveEndpoint = (override: string | undefined, channel: TelemetryBuildChannel): string => {
  if (override) return override
  const syncServer = process.env.SYNC_SERVER_URL
  if (syncServer) return `${syncServer.replace(/\/$/, '')}/telemetry/logs`
  if (channel === 'production') return 'https://sync.memrynote.com/telemetry/logs'
  return 'http://localhost:8787/telemetry/logs'
}

const wrapFetch = (custom?: TelemetryFetch): TelemetryFetch =>
  custom ?? (async (input, init) => net.fetch(input.toString(), init))

export const installLogShip = (deps: LogShipDeps): LogShip => {
  if (logShipInstance) return logShipInstance

  const salt = deps.salt ?? getOrCreateDiagnosticsSalt()
  const hash = makeSaltedHasher(salt)
  const endpoint = resolveEndpoint(deps.endpoint, deps.buildChannel)

  const configuredLevel = deps.level ?? process.env.MEMRY_DIAG_LOG_LEVEL ?? DEFAULT_LEVEL
  // The configured level can only ever raise the bar (e.g. 'error'-only); it can
  // never let info/debug through, so the floor is clamped to >= warn.
  const floorRank = Math.max(LEVEL_ORDER.warn, LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.warn)
  const transportLevel: 'warn' | 'error' = floorRank >= LEVEL_ORDER.error ? 'error' : 'warn'

  // Fixed-capacity circular buffer over preallocated slots. Both evictions (the
  // RING_MS window and the RING_LIMIT cap) only ever drop the oldest entries, so a
  // head index reproduces exactly what the old filter+slice kept — while doing O(1)
  // amortized work per line instead of re-parsing up to RING_LIMIT timestamps and
  // reallocating the array on every warn/error. Epoch ms is captured at push time in
  // a parallel array, so the shipped line shape (`ts` ISO string) is untouched.
  const ringLines = new Array<DiagnosticLogLine | null>(RING_LIMIT).fill(null)
  const ringTsMs = new Array<number>(RING_LIMIT).fill(0)
  let ringHead = 0
  let ringSize = 0

  const pushRing = (line: DiagnosticLogLine, tsMs: number): void => {
    const slot = (ringHead + ringSize) % RING_LIMIT
    ringLines[slot] = line
    ringTsMs[slot] = tsMs
    if (ringSize === RING_LIMIT) ringHead = (ringHead + 1) % RING_LIMIT
    else ringSize += 1
    const cutoff = tsMs - RING_MS
    while (ringSize > 0 && ringTsMs[ringHead] < cutoff) {
      // Null the evicted slot so the ring stops pinning the line object.
      ringLines[ringHead] = null
      ringHead = (ringHead + 1) % RING_LIMIT
      ringSize -= 1
    }
  }

  const snapshotRing = (): DiagnosticLogLine[] => {
    const out: DiagnosticLogLine[] = []
    for (let i = 0; i < ringSize; i++) {
      const line = ringLines[(ringHead + i) % RING_LIMIT]
      if (line) out.push(line)
    }
    return out
  }

  const throttleMap = new Map<string, { line: DiagnosticLogLine; windowStart: number }>()
  const sweepThrottle = (now: number): void => {
    if (throttleMap.size <= THROTTLE_MAX_KEYS) return
    for (const [key, entry] of throttleMap) {
      if (now - entry.windowStart >= THROTTLE_WINDOW_MS) throttleMap.delete(key)
    }
  }

  const buildBody = (lines: DiagnosticLogLine[]): DiagnosticLogBatch => {
    const context = getTelemetryRuntime()?.context
    if (!context) throw new Error('LogShip: telemetry runtime unavailable for batch metadata')
    return {
      schemaVersion: 1,
      installId: context.installId,
      sessionId: context.sessionId,
      appVersion: context.appVersion,
      buildChannel: context.buildChannel,
      platform: context.platform,
      arch: context.arch,
      lines
    }
  }

  const queue: ShipQueue<DiagnosticLogLine> = createShipQueue<DiagnosticLogLine>({
    fetch: wrapFetch(deps.fetch),
    endpoint,
    buildBody,
    persistPath: deps.persistPath
  })

  const enabled = (): boolean => getTelemetryRuntime()?.getSettings().enabled === true

  // Settle the gate once at install, not only on the next log record: lines a
  // crashed session left in the mirror have to become flushable without waiting
  // for a fresh warn/error, and an install with telemetry off has to purge the
  // mirror instead of carrying it forward.
  const syncQueueEnabled = (): void => {
    queue.setEnabled(deps.buildChannel === 'development' ? false : enabled())
  }
  syncQueueEnabled()

  let reentrant = false

  const handleRecord = (
    raw: RawLogRecord,
    origin: 'main' | 'worker',
    workerName?: string
  ): void => {
    if (reentrant) return
    const levelRank = LEVEL_ORDER[raw.level] ?? -1
    if (levelRank < floorRank) return
    const parsed = parseRecord(raw)
    if (SKIP_SCOPES.has(parsed.scope)) return

    reentrant = true
    try {
      const vaultRoot = getCurrentVaultPath() ?? undefined
      const { message, fields } = redactLogLine(parsed, { vaultRoot, hash })

      const now = Date.now()
      const key = `${parsed.level}|${parsed.scope}|${message}`
      const throttled = throttleMap.get(key)
      // Fixed window, anchored to when the line was first emitted (not to the
      // last hit): repeats within THROTTLE_WINDOW_MS of that anchor are
      // suppressed and counted; once the window elapses, the first repeat
      // after it emits a fresh line with its own window/count. This keeps a
      // sustained warning loop visible (~one line per window) instead of
      // suppressing it forever.
      if (throttled && now - throttled.windowStart < THROTTLE_WINDOW_MS) {
        const priorCount =
          typeof throttled.line.fields?.repeatCount === 'number'
            ? throttled.line.fields.repeatCount
            : 1
        throttled.line.fields = { ...(throttled.line.fields ?? {}), repeatCount: priorCount + 1 }
        return
      }

      const line: DiagnosticLogLine = {
        ts: new Date().toISOString(),
        level: parsed.level,
        scope: parsed.scope,
        message,
        // redactFieldValue (redact.ts) only ever returns string/number/boolean;
        // redactLogLine's signature is just wider (Record<string, unknown>) because
        // it is shared with non-typed callers.
        fields: fields as DiagnosticLogLine['fields'],
        origin,
        ...(workerName ? { workerName } : {})
      }
      throttleMap.set(key, { line, windowStart: now })
      sweepThrottle(now)
      pushRing(line, now)

      syncQueueEnabled()
      queue.enqueue(line)
    } finally {
      reentrant = false
    }
  }

  const transportFn = ((message: RawTransportMessage) => {
    handleRecord({ level: message.level, scope: message.scope, data: message.data }, 'main')
  }) as RawTransportFn
  transportFn.level = transportLevel
  ;(log.transports as unknown as MutableTransports).logShip = transportFn

  let flushTimer: ReturnType<typeof setInterval> | null = null
  const intervalMs =
    deps.flushIntervalMs === undefined ? DEFAULT_FLUSH_INTERVAL_MS : deps.flushIntervalMs
  if (intervalMs && Number.isFinite(intervalMs) && intervalMs > 0) {
    flushTimer = setInterval(() => {
      void queue.flush()
    }, intervalMs)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  const ship: LogShip = {
    dispose: async () => {
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      await queue.flush().catch(() => undefined)
      ;(log.transports as unknown as MutableTransports).logShip = null
      logShipInstance = null
    },
    ingestForwarded: (record, workerName) => handleRecord(record, 'worker', workerName),
    recentLines: () => snapshotRing()
  }

  logShipInstance = ship
  return ship
}

export const getLogShip = (): LogShip | null => logShipInstance
