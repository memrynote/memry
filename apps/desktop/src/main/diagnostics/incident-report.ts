// Path B: user-triggered one-time incident reports. Assembles a REDACTED bundle
// (recent redacted log lines + a redacted device/sync snapshot + the triggering
// error) under a generated incident id, and ships it to the server on user
// consent. `buildIncidentReport` is pure given its deps — it is what the renderer
// both previews and sends (the incidentId is generated once by the caller and
// injected, so preview and send produce byte-identical reports).
import { randomBytes } from 'node:crypto'
import { net } from 'electron'

import { redactText } from '@memry/contracts/redact'
import type {
  DiagnosticLogLine,
  DiagnosticReport,
  DiagnosticSnapshot,
  DiagnosticTrigger
} from '@memry/contracts/diagnostics-api'
import type { TelemetryBuildChannel, TelemetryPlatform } from '@memry/contracts/telemetry-api'

import { getStatus as getVaultStatus } from '../vault'
import { getLogShip } from '../telemetry/log-ship'
import { getTelemetryRuntime } from '../telemetry/runtime'
import { getTelemetryAuthState, getTelemetrySyncState } from '../telemetry/state'
import { getOrCreateDiagnosticsSalt, makeSaltedHasher } from '../telemetry/diagnostics-salt'
import type { TelemetryFetch } from '../telemetry/client'
import { getSyncEngine } from '../sync/runtime'
import { getValidAccessToken } from '../sync/token-manager'

// Crockford-ish base32 (no 0/1/8/9 or lowercase) keeps ids unambiguous when read
// aloud/typed into a support ticket. 8 chars satisfies the schema's 6-12 range.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const INCIDENT_ID_CHARS = 8
const STACK_FRAME_LINE = /^\s*at\s/
const STACK_CAP = 4000

// The alphabet is exactly 32 chars (a power of two), so masking the low 5 bits of
// each random byte is a uniform, bias-free index into it — and avoids `%` on a
// CSPRNG byte, which static analysis flags as potential modulo bias.
const BASE32_MASK = BASE32_ALPHABET.length - 1

export const generateIncidentId = (): string => {
  const bytes = randomBytes(INCIDENT_ID_CHARS)
  let id = ''
  for (let i = 0; i < INCIDENT_ID_CHARS; i++) {
    id += BASE32_ALPHABET[bytes[i] & BASE32_MASK]
  }
  return `MEMRY-${id}`
}

interface BuildIncidentReportContext {
  installId: string
  sessionId: string
  appVersion: string
  buildChannel: TelemetryBuildChannel
  platform: TelemetryPlatform
  arch: string
}

export interface BuildIncidentReportDeps {
  incidentId: string
  recentLines: DiagnosticLogLine[]
  context: BuildIncidentReportContext
  snapshot: DiagnosticSnapshot
  /** Salted hasher for the trigger-stack redaction — see makeSaltedHasher. */
  hash: (value: string) => string
  accountId?: string
}

// Drops the header line (can embed a note title/error message verbatim) and keeps
// only stack-frame lines, then redacts each frame (home paths -> ~, content
// basenames -> hashed placeholder; code file frames like foo.ts survive as-is).
const redactStack = (
  stack: string | undefined,
  hash: (value: string) => string
): string | undefined => {
  if (!stack) return undefined
  const frames = stack.split('\n').filter((line) => STACK_FRAME_LINE.test(line))
  if (frames.length === 0) return undefined
  const redacted = frames.map((line) => redactText(line, { hash })).join('\n')
  return redacted.length > STACK_CAP ? redacted.slice(0, STACK_CAP) : redacted
}

export const buildIncidentReport = (
  trigger: DiagnosticTrigger,
  deps: BuildIncidentReportDeps
): DiagnosticReport => {
  const stack = redactStack(trigger.stack, deps.hash)
  return {
    schemaVersion: 1,
    installId: deps.context.installId,
    sessionId: deps.context.sessionId,
    appVersion: deps.context.appVersion,
    buildChannel: deps.context.buildChannel,
    platform: deps.context.platform,
    arch: deps.context.arch,
    incidentId: deps.incidentId,
    trigger: {
      source: trigger.source,
      ...(trigger.errorCode ? { errorCode: trigger.errorCode } : {}),
      ...(stack ? { stack } : {})
    },
    snapshot: deps.snapshot,
    // Already redacted by the log-ship ring buffer on ingest — do not re-redact.
    lines: deps.recentLines,
    ...(deps.accountId ? { accountId: deps.accountId } : {})
  }
}

const resolveEndpoint = (override: string | undefined, channel: TelemetryBuildChannel): string => {
  if (override) return override
  const syncServer = process.env.SYNC_SERVER_URL
  if (syncServer) return `${syncServer.replace(/\/$/, '')}/diagnostics/report`
  if (channel === 'production') return 'https://sync.memrynote.com/diagnostics/report'
  return 'http://localhost:8787/diagnostics/report'
}

export interface SendIncidentReportDeps {
  /** Injectable for tests; defaults to electron's net.fetch. */
  fetch?: TelemetryFetch
  endpoint?: string
  /**
   * Resolves the signed-in account's access token so the server can attribute
   * the report to the same PostHog person as this install's events. Same
   * contract as the telemetry client's: null/throw → anonymous report. The
   * report body's `accountId` is NOT used for this — a body field is
   * client-asserted, the bearer is verified.
   *
   * Injectable for tests; defaults to the real token manager. The default lives
   * here rather than at the IPC call site because `src/main/ipc/**` may not
   * import `src/main/sync/**` (see scripts/check-architecture-boundaries.js).
   */
  getAccessToken?: () => Promise<string | null>
}

export const sendIncidentReport = async (
  report: DiagnosticReport,
  deps: SendIncidentReportDeps
): Promise<{ incidentId: string }> => {
  const endpoint = resolveEndpoint(deps.endpoint, report.buildChannel)
  const fetchFn = deps.fetch ?? ((input, init) => net.fetch(input.toString(), init))
  let bearer: string | null = null
  try {
    bearer = await (deps.getAccessToken ?? getValidAccessToken)()
  } catch {
    // Signed out, keychain locked, refresh failed — send anonymously rather
    // than losing the report.
    bearer = null
  }
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(report)
  })
  if (!response.ok) {
    throw new Error(`Failed to send incident report (status ${response.status})`)
  }
  return { incidentId: report.incidentId }
}

/**
 * Gathers real process/runtime state for an incident report. Thin glue — the
 * interesting logic lives in buildIncidentReport, which this feeds.
 */
export const collectIncidentDeps = (
  _trigger: DiagnosticTrigger
): Omit<BuildIncidentReportDeps, 'accountId'> & { accountId?: string } => {
  const runtime = getTelemetryRuntime()
  if (!runtime) {
    throw new Error(
      'collectIncidentDeps: telemetry runtime unavailable — cannot build incident report'
    )
  }
  const { context } = runtime

  const authState = getTelemetryAuthState()
  const syncState = getTelemetrySyncState()
  // No dedicated queue-depth accessor exists; SyncEngine#getStatus().pendingCount
  // (apps/desktop/src/main/sync/engine.ts) is the real pending-item count and
  // falls back to 0 when no engine is running (signed-out / sync disabled).
  const queueDepth = getSyncEngine()?.getStatus().pendingCount ?? 0

  const snapshot: DiagnosticSnapshot = {
    appVersion: context.appVersion,
    buildChannel: context.buildChannel,
    platform: context.platform,
    arch: context.arch,
    locale: context.locale,
    uptimeSeconds: Math.round(process.uptime()),
    syncEnabled: syncState === 'enabled',
    syncState,
    queueDepth,
    vaultOpen: getVaultStatus().isOpen,
    authState
  }

  return {
    incidentId: generateIncidentId(),
    recentLines: getLogShip()?.recentLines() ?? [],
    context: {
      installId: context.installId,
      sessionId: context.sessionId,
      appVersion: context.appVersion,
      buildChannel: context.buildChannel,
      platform: context.platform,
      arch: context.arch
    },
    snapshot,
    hash: makeSaltedHasher(getOrCreateDiagnosticsSalt())
  }
}
