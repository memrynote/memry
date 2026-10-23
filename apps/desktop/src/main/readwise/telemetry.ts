import type { TelemetryResult } from '@memry/contracts/telemetry-api'
import { toSafeToken } from '@memry/contracts/telemetry-api'
import { trackMainEvent } from '../telemetry/track'
import { ReadwiseError } from './client'
import { ReadwisePullGateError } from './pull-gate'
import type { RunResult } from './sync-service'

/**
 * Readwise telemetry (D12). The allowlist in `@memry/contracts/telemetry-api`
 * holds the event names. Every payload here is a count, a duration, or a
 * short error code: never a title, a highlight, a URL, or the token. The
 * one-shot import keeps its own `import_completed` event (`import/runner.ts`).
 */

/** A stable, bounded code for a failure. Never the error's message, which can hold a URL. */
export function readwiseErrorCode(error: unknown): string {
  for (let cause: unknown = error, depth = 0; cause && depth < 4; depth += 1) {
    if (cause instanceof ReadwiseError) return toSafeToken(cause.code, 'unexpected')
    if (cause instanceof ReadwisePullGateError) return toSafeToken(cause.code, 'unexpected')
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return 'unexpected'
}

/** `source` is how the token arrived: pasted on connect, or pasted again on a takeover (D8). */
export function trackReadwiseConnected(source: 'token' | 'takeover', error?: unknown): void {
  trackMainEvent('readwise_connected', {
    surface: 'vault',
    action: 'connected',
    source,
    result: error === undefined ? 'success' : 'failed',
    ...(error === undefined ? {} : { errorCode: readwiseErrorCode(error) })
  })
}

export function trackReadwiseDisconnected(): void {
  trackMainEvent('readwise_disconnected', {
    surface: 'vault',
    action: 'disconnected',
    source: 'token',
    result: 'success'
  })
}

/** One scheduled or manual run. A refusal by the pull gate is a state, not a failure. */
export function trackReadwiseSync(
  origin: 'scheduled' | 'manual',
  durationMs: number,
  outcome: { result: RunResult } | { error: unknown }
): void {
  if ('error' in outcome) {
    const skipped = outcome.error instanceof ReadwisePullGateError
    trackMainEvent('readwise_sync_completed', {
      surface: 'vault',
      action: 'sync_completed',
      source: origin,
      result: skipped ? 'skipped' : 'failed',
      errorCode: readwiseErrorCode(outcome.error),
      metrics: { durationMs }
    })
    return
  }
  const { result } = outcome
  const status: TelemetryResult = result.cancelled
    ? 'canceled'
    : result.failed > 0
      ? 'failed'
      : 'success'
  trackMainEvent('readwise_sync_completed', {
    surface: 'vault',
    action: 'sync_completed',
    source: origin,
    result: status,
    metrics: {
      durationMs,
      itemCount: result.added + result.updated + result.appended + result.documents,
      resultCount: result.highlights,
      value: result.failed
    }
  })
}
