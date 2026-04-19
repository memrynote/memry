import { z } from 'zod'
import { createLogger } from '../../lib/logger'
import { getGoogleCalendarTokens, storeGoogleCalendarTokens } from './keychain'
import { userMessageForCalendarApiError, userMessageForTokenEndpointError } from './oauth-errors'
import type {
  GoogleCalendarClient,
  GoogleCalendarDescriptor,
  GoogleCalendarRemoteEvent,
  GoogleCalendarUpsertEventInput
} from '../types'

const log = createLogger('Calendar:GoogleClient')
const GOOGLE_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

let pendingRefresh: Promise<string> | null = null

const GoogleCalendarListItemSchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
  backgroundColor: z.string().optional(),
  primary: z.boolean().optional()
})

const GoogleCalendarListSchema = z.object({
  items: z.array(GoogleCalendarListItemSchema).default([])
})

const GoogleEventDateSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional()
})

const GoogleEventSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: GoogleEventDateSchema,
  end: GoogleEventDateSchema.optional(),
  etag: z.string().optional(),
  updated: z.string().optional()
})

const GoogleEventsListSchema = z.object({
  items: z.array(GoogleEventSchema).default([]),
  nextSyncToken: z.string().optional()
})

const GoogleTokenRefreshSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1)
})

const GoogleWatchChannelResponseSchema = z.object({
  id: z.string().min(1),
  resourceId: z.string().min(1),
  expiration: z.union([z.string(), z.number()]).optional()
})

function resolveGoogleClientId(): string {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim()
  if (!clientId) {
    throw new Error('Missing GOOGLE_CALENDAR_CLIENT_ID')
  }
  return clientId
}

function resolveGoogleClientSecret(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || undefined
}

function mapCalendar(item: z.infer<typeof GoogleCalendarListItemSchema>): GoogleCalendarDescriptor {
  return {
    id: item.id,
    title: item.summary ?? item.id,
    timezone: item.timeZone ?? null,
    color: item.backgroundColor ?? null,
    isPrimary: item.primary ?? false
  }
}

function mapRemoteEvent(
  calendarId: string,
  raw: z.infer<typeof GoogleEventSchema>
): GoogleCalendarRemoteEvent {
  const isAllDay = Boolean(raw.start.date && !raw.start.dateTime)
  const timezone = raw.start.timeZone ?? raw.end?.timeZone ?? 'UTC'

  const startAt = raw.start.dateTime ?? `${raw.start.date}T00:00:00.000Z`
  let endAt = raw.end?.dateTime ?? null
  if (!endAt && raw.end?.date) {
    endAt = `${raw.end.date}T00:00:00.000Z`
  }

  return {
    id: raw.id,
    calendarId,
    title: raw.summary ?? 'Untitled event',
    description: raw.description ?? null,
    location: raw.location ?? null,
    startAt,
    endAt,
    isAllDay,
    timezone,
    status: raw.status,
    etag: raw.etag ?? null,
    updatedAt: raw.updated ?? null,
    raw: raw as unknown as Record<string, unknown>
  }
}

function toGoogleEventPayload(event: GoogleCalendarUpsertEventInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    summary: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: event.isAllDay
      ? {
          date: event.startAt.slice(0, 10),
          timeZone: event.timezone
        }
      : {
          dateTime: event.startAt,
          timeZone: event.timezone
        },
    end: event.isAllDay
      ? {
          date: (event.endAt ?? event.startAt).slice(0, 10),
          timeZone: event.timezone
        }
      : {
          dateTime: event.endAt ?? event.startAt,
          timeZone: event.timezone
        },
    extendedProperties: {
      private: {
        memrySourceType: event.sourceType,
        memrySourceId: event.sourceId
      }
    }
  }

  if (event.recurrence && event.recurrence.length > 0) {
    payload.recurrence = event.recurrence
  }

  return payload
}

async function refreshAccessTokenInner(): Promise<string> {
  const clientId = resolveGoogleClientId()
  const clientSecret = resolveGoogleClientSecret()
  const { refreshToken } = await getGoogleCalendarTokens()
  if (!refreshToken) {
    throw new Error('Google Calendar is not connected on this device')
  }

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })
  if (clientSecret) {
    params.set('client_secret', clientSecret)
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let errorCode: string | undefined
    let description: string | undefined
    try {
      const parsed = JSON.parse(raw) as { error?: string; error_description?: string }
      errorCode = parsed.error
      description = parsed.error_description
    } catch {
      // raw already holds the plain-text body
    }
    log.error('Failed to refresh Google Calendar access token', {
      status: response.status,
      error: errorCode ?? 'unknown_error',
      errorDescription: description ?? raw,
      hasClientSecret: Boolean(clientSecret)
    })
    throw new Error(
      userMessageForTokenEndpointError({
        status: response.status,
        errorCode,
        errorDescription: description
      })
    )
  }

  const parsed = GoogleTokenRefreshSchema.parse(await response.json())
  await storeGoogleCalendarTokens({
    accessToken: parsed.access_token,
    refreshToken
  })
  return parsed.access_token
}

async function refreshAccessToken(): Promise<string> {
  if (pendingRefresh) return pendingRefresh
  pendingRefresh = refreshAccessTokenInner().finally(() => {
    pendingRefresh = null
  })
  return pendingRefresh
}

async function throwCalendarApiFailure(response: Response, operation: string): Promise<never> {
  const raw = await response.text().catch(() => '')
  let apiStatus: string | undefined
  let apiMessage: string | undefined
  try {
    const parsed = JSON.parse(raw) as { error?: { status?: string; message?: string } }
    apiStatus = parsed.error?.status
    apiMessage = parsed.error?.message
  } catch {
    // raw body may be empty or plain text
  }
  log.error(`Failed to ${operation}`, {
    status: response.status,
    apiStatus,
    apiMessage,
    body: raw.slice(0, 500)
  })
  const error = new Error(
    userMessageForCalendarApiError({ status: response.status, apiStatus })
  ) as Error & {
    status?: number
    apiStatus?: string
  }
  error.status = response.status
  error.apiStatus = apiStatus
  throw error
}

async function withAuthorizedResponse(
  input: {
    path: string
    init?: RequestInit
    query?: Record<string, string | undefined | null>
  },
  retry = true
): Promise<Response> {
  const tokens = await getGoogleCalendarTokens()
  const accessToken = tokens.accessToken ?? (await refreshAccessToken())

  const url = new URL(`${GOOGLE_API_BASE}${input.path}`)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (typeof value === 'string' && value.length > 0) {
      url.searchParams.set(key, value)
    }
  }

  const response = await fetch(url, {
    ...input.init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(input.init?.headers ?? {})
    }
  })

  if (response.status === 401 && retry) {
    log.warn('Google Calendar access token expired, refreshing')
    await refreshAccessToken()
    return await withAuthorizedResponse(input, false)
  }

  return response
}

export function createGoogleCalendarClient(): GoogleCalendarClient {
  return {
    async listCalendars(): Promise<GoogleCalendarDescriptor[]> {
      const response = await withAuthorizedResponse({
        path: '/users/me/calendarList'
      })

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'list Google calendars')
      }

      const parsed = GoogleCalendarListSchema.parse(await response.json())
      return parsed.items.map(mapCalendar)
    },

    async createCalendar(input): Promise<GoogleCalendarDescriptor> {
      const response = await withAuthorizedResponse({
        path: '/calendars',
        init: {
          method: 'POST',
          body: JSON.stringify({
            summary: input.title,
            timeZone: input.timezone
          })
        }
      })

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'create Google calendar')
      }

      return mapCalendar(GoogleCalendarListItemSchema.parse(await response.json()))
    },

    async listEvents(input): Promise<{
      events: GoogleCalendarRemoteEvent[]
      nextSyncCursor: string | null
    }> {
      const useSyncToken = Boolean(input.syncCursor)

      const response = await withAuthorizedResponse({
        path: `/calendars/${encodeURIComponent(input.calendarId)}/events`,
        query: useSyncToken
          ? {
              showDeleted: 'true',
              singleEvents: 'true',
              syncToken: input.syncCursor!
            }
          : {
              showDeleted: 'true',
              singleEvents: 'true',
              timeMin: input.timeMin ?? undefined,
              timeMax: input.timeMax ?? undefined
            }
      })

      if (response.status === 410) {
        return { events: [], nextSyncCursor: null }
      }

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'list Google calendar events')
      }

      const parsed = GoogleEventsListSchema.parse(await response.json())
      return {
        events: parsed.items.map((item) => mapRemoteEvent(input.calendarId, item)),
        nextSyncCursor: parsed.nextSyncToken ?? null
      }
    },

    async getEvent(input): Promise<GoogleCalendarRemoteEvent> {
      const response = await withAuthorizedResponse({
        path: `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`
      })

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'fetch Google calendar event')
      }

      return mapRemoteEvent(input.calendarId, GoogleEventSchema.parse(await response.json()))
    },

    async upsertEvent(input): Promise<GoogleCalendarRemoteEvent> {
      const isUpdate = typeof input.eventId === 'string' && input.eventId.length > 0
      const headers: Record<string, string> = {}
      if (isUpdate && input.ifMatch) {
        headers['If-Match'] = input.ifMatch
      }
      const response = await withAuthorizedResponse({
        path: isUpdate
          ? `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId!)}`
          : `/calendars/${encodeURIComponent(input.calendarId)}/events`,
        init: {
          method: isUpdate ? 'PATCH' : 'POST',
          headers,
          body: JSON.stringify(toGoogleEventPayload(input.event))
        }
      })

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'upsert Google calendar event')
      }

      return mapRemoteEvent(input.calendarId, GoogleEventSchema.parse(await response.json()))
    },

    async deleteEvent(input): Promise<void> {
      const response = await withAuthorizedResponse({
        path: `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
        init: {
          method: 'DELETE'
        }
      })

      if (!response.ok && response.status !== 404) {
        await throwCalendarApiFailure(response, 'delete Google calendar event')
      }
    },

    async watchCalendar(input): Promise<{ resourceId: string; expiration: number }> {
      const expirationMs = Date.now() + input.ttlSeconds * 1000
      const response = await withAuthorizedResponse({
        path: `/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
        init: {
          method: 'POST',
          body: JSON.stringify({
            id: input.channelId,
            token: input.token,
            type: 'web_hook',
            address: input.webhookUrl,
            expiration: String(expirationMs)
          })
        }
      })

      if (!response.ok) {
        await throwCalendarApiFailure(response, 'watch Google calendar')
      }

      const parsed = GoogleWatchChannelResponseSchema.parse(await response.json())
      const expiration =
        typeof parsed.expiration === 'string'
          ? Number(parsed.expiration)
          : (parsed.expiration ?? expirationMs)
      return {
        resourceId: parsed.resourceId,
        expiration: Number.isFinite(expiration) ? expiration : expirationMs
      }
    },

    async stopChannel(input): Promise<void> {
      const response = await withAuthorizedResponse({
        path: '/channels/stop',
        init: {
          method: 'POST',
          body: JSON.stringify({
            id: input.channelId,
            resourceId: input.resourceId
          })
        }
      })

      if (!response.ok && response.status !== 404) {
        await throwCalendarApiFailure(response, 'stop Google calendar channel')
      }
    }
  }
}
