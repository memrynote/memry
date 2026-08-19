import { redactLogLine, redactText } from '@memry/contracts/redact'
import type { DiagnosticLogLine, DiagnosticReport } from '@memry/contracts/diagnostics-api'
import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'

import type { PostHogEnv } from './posthog'

// Log lines → PostHog Logs, a plain OTLP receiver. No OpenTelemetry SDK: the
// endpoint accepts OTLP-JSON over HTTP with the project token as a bearer, which
// is the same shape as the Loki pusher this replaces and suits a Worker.
//
// Retention is 14 days. Anything that must outlive that cannot rely on this path.

const logger = createLogger('PostHogLogs')

const DEFAULT_HOST = 'https://us.i.posthog.com'

// The public ingest path is `/i/v1/logs`, NOT `/v1/logs`. Only the internal
// capture-logs service binds both; on the edge host `/v1/logs` is an unrouted
// 404, and because every push here is fire-and-forget the failure is invisible.
// Same `/i/` prefix as `/i/v1/traces` and `/i/v1/metrics`. Do not "simplify" it.
const LOGS_PATH = '/i/v1/logs'

export interface LogRecord {
  level: 'warn' | 'error'
  app: 'desktop' | 'server'
  kind?: 'error' | 'log' | 'report'
  distinctId?: string
  line: Record<string, unknown>
}

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })

export const pushPostHogLogs = async (env: PostHogEnv, records: LogRecord[]): Promise<void> => {
  if (!env.POSTHOG_KEY || records.length === 0) return
  const host = env.POSTHOG_HOST ?? DEFAULT_HOST
  const environment = env.ENVIRONMENT ?? 'unknown'
  const timeUnixNano = `${Date.now()}000000`

  try {
    // One resourceLogs entry per app so service.name stays a resource attribute
    // rather than being duplicated onto every record.
    const byApp = new Map<LogRecord['app'], LogRecord[]>()
    for (const record of records) {
      const bucket = byApp.get(record.app) ?? []
      bucket.push(record)
      byApp.set(record.app, bucket)
    }

    const resourceLogs = [...byApp.entries()].map(([app, appRecords]) => ({
      resource: {
        attributes: [
          attribute('service.name', app),
          attribute('deployment.environment', environment)
        ]
      },
      scopeLogs: [
        {
          logRecords: appRecords.map((record) => ({
            timeUnixNano,
            severityText: record.level,
            body: { stringValue: JSON.stringify(record.line) },
            attributes: [
              attribute('kind', record.kind ?? 'error'),
              ...(record.distinctId ? [attribute('posthogDistinctId', record.distinctId)] : [])
            ]
          }))
        }
      ]
    }))

    const response = await fetch(`${host}${LOGS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.POSTHOG_KEY}`
      },
      body: JSON.stringify({ resourceLogs })
    })
    if (!response.ok) logger.warn('PostHog log push failed', { status: response.status })
  } catch (error) {
    logger.warn('PostHog log push failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

// Desktop error events may carry a redacted message alongside stack frames —
// TelemetryErrorDetailSchema.message is optional, permitted only after the
// client has run it through redactText; the server re-runs redaction here as
// a backstop.
export const desktopErrorRecord = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  distinctId: string
): LogRecord => ({
  level: 'error',
  app: 'desktop',
  kind: 'error',
  distinctId,
  line: {
    name: event.name,
    error_code: event.errorCode ?? '',
    surface: event.surface,
    action: event.action,
    source: event.source ?? '',
    app_version: batch.appVersion,
    build_channel: batch.buildChannel,
    platform: batch.platform,
    message: event.error?.message ? redactText(event.error.message, {}) : '',
    stack: event.error?.stack ?? '',
    component_stack: event.error?.componentStack ?? '',
    install_hash: distinctId,
    // The queryable half of a failed request (#1584). Empty string when absent,
    // same convention as exit_code — and for `retryable` that matters, because
    // `false` is a real answer ("this will never succeed") that must not read
    // as "not reported".
    http_status: event.failure?.httpStatus ?? '',
    server_code: event.failure?.serverCode ?? '',
    retryable: event.failure?.retryable ?? '',
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

export const desktopLogRecord = (
  line: DiagnosticLogLine,
  meta: DesktopMeta,
  distinctId: string
): LogRecord => {
  // Defense-in-depth: client already redacted; re-run mask-mode (no hasher) to scrub
  // anything that slipped through. Never throws.
  const safe = redactLogLine({ message: line.message, fields: line.fields }, {})
  return {
    level: line.level,
    app: 'desktop',
    kind: 'log',
    distinctId,
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
      install_hash: distinctId
    }
  }
}

export const desktopReportRecords = (report: DiagnosticReport, distinctId: string): LogRecord[] => {
  const summary: LogRecord = {
    level: 'error',
    app: 'desktop',
    kind: 'report',
    distinctId,
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
      install_hash: distinctId
    }
  }
  const lines = report.lines.map((l) => {
    const r = desktopLogRecord(
      l,
      {
        appVersion: report.appVersion,
        buildChannel: report.buildChannel,
        platform: report.platform,
        arch: report.arch
      },
      distinctId
    )
    r.kind = 'report'
    r.line.incident_id = report.incidentId
    return r
  })
  return [summary, ...lines]
}
