import { redactLogLine } from '@memry/contracts/redact'
import type { DiagnosticLogLine, DiagnosticReport } from '@memry/contracts/diagnostics-api'
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
  kind?: 'error' | 'log' | 'report'
  line: Record<string, unknown>
}

export const pushLokiEntries = async (env: LokiEnv, entries: LokiEntry[]): Promise<void> => {
  if (!env.LOKI_URL || !env.LOKI_TOKEN || entries.length === 0) return
  try {
    const ts = `${Date.now()}000000`
    const streams = entries.map((entry) => ({
      stream: {
        app: entry.app,
        env: env.ENVIRONMENT ?? 'unknown',
        level: entry.level,
        kind: entry.kind ?? 'error'
      },
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
  kind: 'error',
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

interface DesktopMeta {
  appVersion: string
  buildChannel: string
  platform: string
  arch: string
}

export const desktopLogEntry = (
  line: DiagnosticLogLine,
  meta: DesktopMeta,
  installHash: string
): LokiEntry => {
  // Defense-in-depth: client already redacted; re-run mask-mode (no hasher) to scrub
  // anything that slipped through. Never throws.
  const safe = redactLogLine({ message: line.message, fields: line.fields }, {})
  return {
    level: line.level,
    app: 'desktop',
    kind: 'log',
    line: {
      ts: line.ts,
      scope: line.scope,
      action: line.action ?? '',
      message: safe.message,
      error_code: line.errorCode ?? '',
      origin: line.origin,
      worker_name: line.workerName ?? '',
      fields: safe.fields,
      app_version: meta.appVersion,
      build_channel: meta.buildChannel,
      platform: meta.platform,
      install_hash: installHash
    }
  }
}

export const desktopReportEntry = (report: DiagnosticReport, installHash: string): LokiEntry[] => {
  const summary: LokiEntry = {
    level: 'error',
    app: 'desktop',
    kind: 'report',
    line: {
      incident_id: report.incidentId,
      kind: 'summary',
      trigger_source: report.trigger.source,
      trigger_error_code: report.trigger.errorCode ?? '',
      trigger_stack: redactLogLine({ message: report.trigger.stack ?? '' }, {}).message,
      snapshot: report.snapshot,
      app_version: report.appVersion,
      build_channel: report.buildChannel,
      platform: report.platform,
      install_hash: installHash
    }
  }
  const lines = report.lines.map((l) => {
    const e = desktopLogEntry(
      l,
      {
        appVersion: report.appVersion,
        buildChannel: report.buildChannel,
        platform: report.platform,
        arch: report.arch
      },
      installHash
    )
    e.kind = 'report'
    e.line.incident_id = report.incidentId
    return e
  })
  return [summary, ...lines]
}
