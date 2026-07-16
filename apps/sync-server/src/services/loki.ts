import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'

// Error log lines → Loki on the Grafana VPS, pushed through Caddy with a
// bearer token. Fire-and-forget: absent config or a failed push must never
// affect request handling. Labels stay low-cardinality (app/env/level);
// everything else lives inside the JSON log line.

const logger = createLogger('Loki')

export interface LokiEnv {
  LOKI_URL?: string
  LOKI_TOKEN?: string
  ENVIRONMENT?: string
}

export interface LokiEntry {
  level: 'warn' | 'error'
  app: 'desktop' | 'server'
  line: Record<string, unknown>
}

export const pushLokiEntries = async (env: LokiEnv, entries: LokiEntry[]): Promise<void> => {
  if (!env.LOKI_URL || !env.LOKI_TOKEN || entries.length === 0) return
  try {
    const ts = `${Date.now()}000000`
    const streams = entries.map((entry) => ({
      stream: { app: entry.app, env: env.ENVIRONMENT ?? 'unknown', level: entry.level },
      values: [[ts, JSON.stringify(entry.line)]]
    }))
    const response = await fetch(`${env.LOKI_URL}/loki/api/v1/push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LOKI_TOKEN}`
      },
      body: JSON.stringify({ streams })
    })
    if (!response.ok) logger.warn('Loki push failed', { status: response.status })
  } catch (error) {
    logger.warn('Loki push failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

// Desktop events carry stack frames only (TelemetryErrorDetailSchema has no
// message field by design — messages can embed note content).
export const desktopErrorEntry = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  installHash: string
): LokiEntry => ({
  level: 'error',
  app: 'desktop',
  line: {
    name: event.name,
    error_code: event.errorCode ?? '',
    surface: event.surface,
    action: event.action,
    source: event.source ?? '',
    app_version: batch.appVersion,
    build_channel: batch.buildChannel,
    platform: batch.platform,
    stack: event.error?.stack ?? '',
    component_stack: event.error?.componentStack ?? '',
    install_hash: installHash,
    // Log-type error events (app_log_recorded) have no stack; log_action is
    // what makes them identifiable in Grafana (e.g. child_process_gone).
    log_action: event.dimensions?.log_action ?? '',
    // child_process_gone carries the platform exit status here (POSIX signal:
    // 11 SIGSEGV, 6 SIGABRT). Kept out of error_code so crashes still group by
    // worker. Empty string (not 0) when absent — exit code 0 is meaningful.
    exit_code: event.metrics?.value ?? ''
  }
})
