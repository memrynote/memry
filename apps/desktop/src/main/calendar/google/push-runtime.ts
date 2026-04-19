import { randomBytes, createHmac, randomUUID } from 'node:crypto'
import { createLogger } from '../../lib/logger'
import { deleteFromServer, patchToServer, postToServer } from '../../sync/http-client'
import { getValidAccessToken } from '../../sync/token-manager'
import { createGoogleCalendarClient } from './client'
import { resolveDefaultGoogleAccountId } from './oauth'
import { requireDatabase } from '../../database'
import { createGoogleChannelManager, type GoogleChannelManager } from './google-channel-manager'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'

const log = createLogger('Calendar:GooglePushRuntime')

const DEFAULT_WEBHOOK_URL = 'https://sync.memry.io/webhooks/google-calendar'
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

function resolveWebhookUrl(): string {
  return process.env.MEMRY_CALENDAR_WEBHOOK_URL?.trim() || DEFAULT_WEBHOOK_URL
}

function resolveHmacKey(): string {
  return process.env.MEMRY_WEBHOOK_HMAC_KEY?.trim() ?? ''
}

function isPushFeatureEnabled(): boolean {
  return process.env.CALENDAR_PUSH_ENABLED === '1' && resolveHmacKey().length > 0
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
  onActiveCountChange: (count: number) => void
): GoogleChannelManager {
  const hmacKey = resolveHmacKey()
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
    hashToken: async (plaintext) => createHmac('sha256', hmacKey).update(plaintext).digest('hex'),
    generateToken: () => randomBytes(32).toString('hex'),
    generateChannelId: () => randomUUID(),
    webhookUrl: resolveWebhookUrl(),
    ttlSeconds: TTL_SECONDS,
    rotationMarginSeconds: ROTATION_MARGIN_SECONDS,
    featureEnabled: isPushFeatureEnabled(),
    onActiveCountChange
  })
}

let prodRuntime: GooglePushRuntime | null = null

export function getOrInitGooglePushRuntime(opts: {
  onActiveCountChange: (count: number) => void
}): GooglePushRuntime | null {
  if (!isPushFeatureEnabled()) return null
  if (!prodRuntime) {
    prodRuntime = createGooglePushRuntime(buildProductionChannelManager(opts.onActiveCountChange))
  }
  return prodRuntime
}

export function getGooglePushRuntime(): GooglePushRuntime | null {
  return prodRuntime
}

export function __testing_resetGooglePushRuntime(): void {
  prodRuntime = null
}
