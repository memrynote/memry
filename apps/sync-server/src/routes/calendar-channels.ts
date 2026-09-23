import { Hono } from 'hono'
import { z } from 'zod'

import { authMiddleware } from '../middleware/auth'
import { hashChannelToken } from '../services/google-webhooks'
import type { AppContext } from '../types'

const HEX_64 = /^[0-9a-f]{64}$/

// `token` is the plaintext channel token the client also hands to Google; the
// server HMACs it with WEBHOOK_HMAC_KEY so the key never leaves the Worker.
// `tokenHash` is the legacy shape: older desktop builds hashed client-side with
// a copy of the key. Still accepted so those builds keep registering.
const RegisterSchema = z
  .object({
    channelId: z.string().min(1),
    sourceId: z.string().min(1),
    token: z.string().regex(HEX_64).optional(),
    tokenHash: z.string().regex(HEX_64).optional(),
    expiresAt: z.number().int().positive()
  })
  .refine((body) => (body.token === undefined) !== (body.tokenHash === undefined), {
    message: 'Exactly one of token or tokenHash is required'
  })

const PatchSchema = z.object({
  resourceId: z.string().min(1)
})

export const calendarChannels = new Hono<AppContext>()

calendarChannels.use('*', authMiddleware)

calendarChannels.post('/', async (c) => {
  const parsed = RegisterSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400)
  }
  const { channelId, sourceId, token, expiresAt } = parsed.data
  const tokenHash =
    token !== undefined
      ? await hashChannelToken(c.env.WEBHOOK_HMAC_KEY, token)
      : parsed.data.tokenHash!
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const nowSec = Math.floor(Date.now() / 1000)

  // A device holds at most one live channel per source. Channels orphaned by an
  // app quit that never reached stop() keep firing on Google's side until they
  // expire (7 days); dropping their rows turns those pings into cheap 401s
  // instead of one extra calendar sync per stale channel per change.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM google_calendar_channels
       WHERE user_id = ? AND device_id = ? AND source_id = ?`
    ).bind(userId, deviceId, sourceId),
    c.env.DB.prepare(
      `INSERT INTO google_calendar_channels
         (channel_id, user_id, device_id, source_id, resource_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
    ).bind(channelId, userId, deviceId, sourceId, tokenHash, expiresAt, nowSec)
  ])

  return c.json({ channelId, expiresAt }, 201)
})

calendarChannels.patch('/:id', async (c) => {
  const parsed = PatchSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400)
  }
  const userId = c.get('userId')!
  const result = await c.env.DB.prepare(
    `UPDATE google_calendar_channels SET resource_id = ?
     WHERE channel_id = ? AND user_id = ?`
  )
    .bind(parsed.data.resourceId, c.req.param('id'), userId)
    .run()
  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.body(null, 204)
})

calendarChannels.delete('/:id', async (c) => {
  const userId = c.get('userId')!
  const result = await c.env.DB.prepare(
    `DELETE FROM google_calendar_channels WHERE channel_id = ? AND user_id = ?`
  )
    .bind(c.req.param('id'), userId)
    .run()
  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.body(null, 204)
})
