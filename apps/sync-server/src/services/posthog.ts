import { createLogger } from '../lib/logger'

// Product, business and exception events → PostHog capture API. Fire-and-forget:
// absent config or a failed post must never affect request handling. Same posture
// as the Loki pusher this replaces.

const logger = createLogger('PostHog')

const DEFAULT_HOST = 'https://us.i.posthog.com'

export interface PostHogEnv {
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
  ENVIRONMENT?: string
}

export interface PostHogEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
  timestamp?: string
}

export const capturePostHogEvents = async (
  env: PostHogEnv,
  events: PostHogEvent[]
): Promise<void> => {
  if (!env.POSTHOG_KEY || events.length === 0) return
  const host = env.POSTHOG_HOST ?? DEFAULT_HOST
  try {
    const response = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events })
    })
    if (!response.ok) logger.warn('PostHog capture failed', { status: response.status })
  } catch (error) {
    logger.warn('PostHog capture failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
