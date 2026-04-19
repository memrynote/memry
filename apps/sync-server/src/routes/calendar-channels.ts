import { Hono } from 'hono'
import { z } from 'zod'

import { authMiddleware } from '../middleware/auth'
import type { AppContext } from '../types'

const RegisterSchema = z.object({
  channelId: z.string().min(1),
  sourceId: z.string().min(1),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number().int().positive()
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
  const { channelId, sourceId, tokenHash, expiresAt } = parsed.data
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const nowSec = Math.floor(Date.now() / 1000)

  await c.env.DB.prepare(
    `INSERT INTO google_calendar_channels
       (channel_id, user_id, device_id, source_id, resource_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
  )
    .bind(channelId, userId, deviceId, sourceId, tokenHash, expiresAt, nowSec)
    .run()

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
