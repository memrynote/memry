import { createLogger } from '../lib/logger'

import type { PostHogEnv } from './posthog'

// Log lines → PostHog Logs, a plain OTLP receiver. No OpenTelemetry SDK: the
// endpoint accepts OTLP-JSON over HTTP with the project token as a bearer, which
// is the same shape as the Loki pusher this replaces and suits a Worker.
//
// Retention is 14 days. Anything that must outlive that cannot rely on this path.

const logger = createLogger('PostHogLogs')

const DEFAULT_HOST = 'https://us.i.posthog.com'

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
      attributes: [attribute('service.name', app), attribute('deployment.environment', environment)]
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

  try {
    const response = await fetch(`${host}/v1/logs`, {
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
