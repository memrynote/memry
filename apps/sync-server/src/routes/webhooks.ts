import { Hono } from 'hono'

import { createLogger } from '../lib/logger'
import { lookupChannel, verifyChannelToken } from '../services/google-webhooks'
import type { AppContext } from '../types'

const log = createLogger('Webhooks')

export const webhooks = new Hono<AppContext>()

webhooks.post('/google-calendar', async (c) => {
  const channelId = c.req.header('x-goog-channel-id')
  const channelToken = c.req.header('x-goog-channel-token')
  const resourceState = c.req.header('x-goog-resource-state')

  if (!channelId || !channelToken || !resourceState) {
    return c.json({ error: 'Missing Google channel headers' }, 400)
  }

  const channel = await lookupChannel(c.env.DB, channelId)
  if (!channel) {
    log.warn('Unknown channel in Google webhook', { channelId })
    return c.json({ error: 'Unknown channel' }, 401)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (channel.expires_at <= nowSec) {
    log.info('Expired channel pinged by Google; returning 410 to stop retries', { channelId })
    return c.json({ error: 'Channel expired' }, 410)
  }

  const ok = await verifyChannelToken(c.env.WEBHOOK_HMAC_KEY, channelToken, channel.token_hash)
  if (!ok) {
    log.warn('Channel token mismatch', { channelId })
    return c.json({ error: 'Token mismatch' }, 401)
  }

  if (resourceState === 'sync') {
    return c.body(null, 200)
  }

  const doId = c.env.USER_SYNC_STATE.idFromName(channel.user_id)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  c.executionCtx.waitUntil(
    stub.fetch(
      new Request(new URL('/broadcast', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excludeDeviceId: '',
          type: 'calendar_changes_available',
          sourceId: channel.source_id
        })
      })
    )
  )

  return c.body(null, 200)
})
