import { randomBytes, randomUUID } from 'node:crypto'
import { resolveSyncServerUrl } from '@memry/sync-client/sync-server-url'
import { createLogger } from '../../lib/logger'
import { deleteFromServer, patchToServer, postToServer } from '../../sync/http-client'
import { getValidAccessToken } from '../../sync/token-manager'
import { createGoogleCalendarClient } from './client'
import { resolveDefaultGoogleAccountId } from './oauth'
import { requireDatabase } from '../../database'
import { createGoogleChannelManager, type GoogleChannelManager } from './google-channel-manager'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'

const log = createLogger('Calendar:GooglePushRuntime')

const WEBHOOK_PATH = '/webhooks/google-calendar'
const TTL_SECONDS = 7 * 24 * 60 * 60
const ROTATION_MARGIN_SECONDS = 60 * 60

export interface CalendarSourceLite {
  id: string
  remoteId: string
  isMemryManaged: boolean
}

export interface GooglePushRuntime {
  ensureForSelectedSources(sources: CalendarSourceLite[]): Promise<void>
  stopAll(): Promise<void>
  handleSelectionToggle(args: {
    sourceId: string
    isSelected: boolean
    calendarId: string
  }): Promise<void>
  getActiveChannelCount(): number
}

export function createGooglePushRuntime(manager: GoogleChannelManager): GooglePushRuntime {
  return {
    async ensureForSelectedSources(sources) {
      const candidates = sources.filter((s) => !s.isMemryManaged)
      for (const source of candidates) {
        try {
          await manager.ensureChannelForSource({
            sourceId: source.id,
            calendarId: source.remoteId
          })
        } catch (err) {
          log.warn('ensureChannelForSource failed; will retry on next start', {
            sourceId: source.id,
            err
          })
        }
      }
    },
    async stopAll() {
      try {
        await manager.stopAll()
      } catch (err) {
        log.warn('stopAll failed; server cleanup cron will reap', { err })
      }
    },
    async handleSelectionToggle({ sourceId, isSelected, calendarId }) {
      try {
        if (isSelected) {
          await manager.ensureChannelForSource({ sourceId, calendarId })
        } else {
          await manager.stopForSource(sourceId)
        }
      } catch (err) {
        log.warn('handleSelectionToggle failed', { sourceId, isSelected, err })
      }
    },
    getActiveChannelCount: () => manager.getActiveChannelCount()
  }
}

// Webhooks land on the same sync-server the channel is registered with, so a
// staging build never registers on staging while Google pings production.
// MEMRY_CALENDAR_WEBHOOK_URL overrides it for local dev behind a public tunnel.
function resolveWebhookUrl(): string | null {
  const override = process.env.MEMRY_CALENDAR_WEBHOOK_URL?.trim()
  if (override) return override
  try {
    return `${resolveSyncServerUrl()}${WEBHOOK_PATH}`
  } catch {
    return null
  }
}

// Push is on by default wherever Google can reach the webhook: Google only
// delivers to HTTPS with a valid certificate, so a plain http://localhost dev
// server stays on the poll runner without any config. CALENDAR_PUSH_ENABLED=0
// is the kill switch; the poll runner covers everything push would deliver.
// Returns the webhook URL when push is enabled, null otherwise.
function resolvePushWebhookUrl(): string | null {
  if (process.env.CALENDAR_PUSH_ENABLED?.trim() === '0') return null
  const url = resolveWebhookUrl()
  return url?.startsWith('https://') ? url : null
}

export function resolvePushAccountIdForSource(sourceId: string, db = requireDatabase()): string {
  const source = getCalendarSourceById(db, sourceId)
  const accountId = source?.accountId ?? resolveDefaultGoogleAccountId(db)
  if (!accountId) {
    throw new Error(`Cannot resolve Google push account for source ${sourceId}`)
  }
  return accountId
}

function buildProductionChannelManager(
  webhookUrl: string,
  onActiveCountChange: (count: number) => void
): GoogleChannelManager {
  return createGoogleChannelManager({
    client: {
      watchCalendar: async () => {
        throw new Error('Google push runtime requires a source-scoped client')
      },
      stopChannel: async () => {
        throw new Error('Google push runtime requires a source-scoped client')
      }
    },
    resolveClient: ({ sourceId }) =>
      createGoogleCalendarClient({
        accountId: resolvePushAccountIdForSource(sourceId, requireDatabase())
      }),
    registerOnServer: async (body) => {
      const token = await getValidAccessToken()
      if (!token) throw new Error('Not signed in — cannot register push channel')
      await postToServer('/calendar/channels', body, token)
    },
    attachResourceId: async ({ channelId, resourceId }) => {
      const token = await getValidAccessToken()
      if (!token) throw new Error('Not signed in — cannot attach resourceId')
      await patchToServer(
        `/calendar/channels/${encodeURIComponent(channelId)}`,
        { resourceId },
        token
      )
    },
    deleteOnServer: async ({ channelId }) => {
      const token = await getValidAccessToken()
      if (!token) return
      await deleteFromServer(`/calendar/channels/${encodeURIComponent(channelId)}`, token).catch(
        () => {
          // Server-side cleanup cron will reap orphans; best-effort delete.
        }
      )
    },
    generateToken: () => randomBytes(32).toString('hex'),
    generateChannelId: () => randomUUID(),
    webhookUrl,
    ttlSeconds: TTL_SECONDS,
    rotationMarginSeconds: ROTATION_MARGIN_SECONDS,
    featureEnabled: true,
    onActiveCountChange
  })
}

let prodRuntime: GooglePushRuntime | null = null

export function getOrInitGooglePushRuntime(opts: {
  onActiveCountChange: (count: number) => void
}): GooglePushRuntime | null {
  const webhookUrl = resolvePushWebhookUrl()
  if (!webhookUrl) return null
  if (!prodRuntime) {
    prodRuntime = createGooglePushRuntime(
      buildProductionChannelManager(webhookUrl, opts.onActiveCountChange)
    )
  }
  return prodRuntime
}

export function getGooglePushRuntime(): GooglePushRuntime | null {
  return prodRuntime
}

export function __testing_resetGooglePushRuntime(): void {
  prodRuntime = null
}
