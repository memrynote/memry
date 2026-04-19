import { createLogger } from '../../lib/logger'
import type { GoogleCalendarClient } from '../types'

const log = createLogger('Calendar:GoogleChannelManager')

type GoogleChannelClient = Pick<GoogleCalendarClient, 'watchCalendar' | 'stopChannel'>

export interface GoogleChannelManagerDeps {
  client: GoogleChannelClient
  resolveClient?(input: { sourceId: string; calendarId: string }): GoogleChannelClient
  registerOnServer(input: {
    channelId: string
    sourceId: string
    tokenHash: string
    expiresAt: number
  }): Promise<void>
  attachResourceId(input: { channelId: string; resourceId: string }): Promise<void>
  deleteOnServer(input: { channelId: string }): Promise<void>
  hashToken(plaintext: string): Promise<string>
  generateToken(): string
  generateChannelId(): string
  webhookUrl: string
  ttlSeconds: number
  rotationMarginSeconds: number
  featureEnabled: boolean
  now?: () => number
  onActiveCountChange?: (count: number) => void
}

export interface GoogleChannelManager {
  ensureChannelForSource(input: { sourceId: string; calendarId: string }): Promise<void>
  stopForSource(sourceId: string): Promise<void>
  stopAll(): Promise<void>
  getActiveChannelCount(): number
}

interface ChannelState {
  sourceId: string
  calendarId: string
  channelId: string
  resourceId: string
  expirationMs: number
  rotationTimer: ReturnType<typeof setTimeout>
  client: GoogleChannelClient
}

export function createGoogleChannelManager(deps: GoogleChannelManagerDeps): GoogleChannelManager {
  const states = new Map<string, ChannelState>()

  function emitCount(): void {
    deps.onActiveCountChange?.(states.size)
  }

  async function registerFresh(sourceId: string, calendarId: string): Promise<ChannelState> {
    const channelId = deps.generateChannelId()
    const plaintextToken = deps.generateToken()
    const tokenHash = await deps.hashToken(plaintextToken)
    const nowMs = (deps.now ?? Date.now)()
    const expirationMs = nowMs + deps.ttlSeconds * 1000
    const expiresAt = Math.floor(nowMs / 1000) + deps.ttlSeconds
    const client = deps.resolveClient?.({ sourceId, calendarId }) ?? deps.client

    await deps.registerOnServer({ channelId, sourceId, tokenHash, expiresAt })

    const watchResult = await client.watchCalendar({
      calendarId,
      channelId,
      token: plaintextToken,
      webhookUrl: deps.webhookUrl,
      ttlSeconds: deps.ttlSeconds
    })

    await deps.attachResourceId({ channelId, resourceId: watchResult.resourceId })

    const rotationDelayMs = Math.max(1, (deps.ttlSeconds - deps.rotationMarginSeconds) * 1000)
    const rotationTimer = setTimeout(() => {
      void rotate(sourceId)
    }, rotationDelayMs)
    if (typeof rotationTimer === 'object' && rotationTimer && 'unref' in rotationTimer) {
      ;(rotationTimer as { unref: () => void }).unref()
    }

    return {
      sourceId,
      calendarId,
      channelId,
      resourceId: watchResult.resourceId,
      expirationMs: watchResult.expiration ?? expirationMs,
      rotationTimer,
      client
    }
  }

  async function rotate(sourceId: string): Promise<void> {
    const prev = states.get(sourceId)
    if (!prev) return
    log.info('Rotating Google push channel', { sourceId, channelId: prev.channelId })
    try {
      await stopForSource(sourceId, { silent: true })
    } catch (err) {
      log.warn('Rotation: failed to stop old channel (continuing to re-register)', {
        sourceId,
        channelId: prev.channelId,
        err
      })
    }
    try {
      const fresh = await registerFresh(sourceId, prev.calendarId)
      states.set(sourceId, fresh)
      emitCount()
    } catch (err) {
      log.error('Rotation: failed to register fresh channel', { sourceId, err })
    }
  }

  async function stopForSource(
    sourceId: string,
    options: { silent?: boolean } = {}
  ): Promise<void> {
    const state = states.get(sourceId)
    if (!state) return

    clearTimeout(state.rotationTimer)
    states.delete(sourceId)

    try {
      await state.client.stopChannel({
        channelId: state.channelId,
        resourceId: state.resourceId
      })
    } catch (err) {
      log.warn('stopChannel on Google failed (ignoring)', {
        sourceId,
        channelId: state.channelId,
        err
      })
    }

    try {
      await deps.deleteOnServer({ channelId: state.channelId })
    } catch (err) {
      log.warn('deleteOnServer failed (ignoring; cron will reap)', {
        sourceId,
        channelId: state.channelId,
        err
      })
    }

    if (!options.silent) {
      emitCount()
    }
  }

  async function ensureChannelForSource(input: {
    sourceId: string
    calendarId: string
  }): Promise<void> {
    if (!deps.featureEnabled) return
    if (states.has(input.sourceId)) return

    const state = await registerFresh(input.sourceId, input.calendarId)
    states.set(input.sourceId, state)
    emitCount()
  }

  async function stopAll(): Promise<void> {
    const ids = Array.from(states.keys())
    await Promise.all(ids.map((id) => stopForSource(id, { silent: true })))
    emitCount()
  }

  function getActiveChannelCount(): number {
    return states.size
  }

  return {
    ensureChannelForSource,
    stopForSource: (id: string) => stopForSource(id),
    stopAll,
    getActiveChannelCount
  }
}
