import { Hono } from 'hono'
import { z } from 'zod'

import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import { getDevice, listDevices, revokeDevice, updateDevice } from '../services/device'
import type { AppContext } from '../types'

const RenameDeviceSchema = z.object({
  name: z.string().min(1).max(100)
})

const deviceListRateLimit = createRateLimiter({
  keyPrefix: 'device_list',
  maxRequests: 30,
  windowSeconds: 60
})

const deviceMutateRateLimit = createRateLimiter({
  keyPrefix: 'device_mutate',
  maxRequests: 10,
  windowSeconds: 60
})

export const devices = new Hono<AppContext>()

devices.use('*', authMiddleware)

devices.get('/', deviceListRateLimit, async (c) => {
  const userId = c.get('userId')!
  const result = await listDevices(c.env.DB, userId)

  const mapped = result.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    lastSyncAt: d.last_sync_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at
  }))

  return c.json({ devices: mapped })
})

devices.delete('/:id', deviceMutateRateLimit, async (c) => {
  const userId = c.get('userId')!
  const callerDeviceId = c.get('deviceId')!
  const deviceId = c.req.param('id')

  if (deviceId === callerDeviceId) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Cannot remove the current device', 400)
  }

  const device = await getDevice(c.env.DB, deviceId, userId)
  if (!device) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_NOT_FOUND, 'Device not found', 404)
  }

  if (device.revoked_at) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_REVOKED, 'Device already revoked', 409)
  }

  await revokeDevice(c.env.DB, deviceId, userId)

  const doId = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  await stub.fetch(
    new Request('https://do/revoke-device', {
      method: 'POST',
      body: JSON.stringify({ deviceId })
    })
  )

  return c.json({ success: true })
})

devices.patch('/:id', deviceMutateRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.req.param('id')

  const body = await c.req.json()
  const parsed = RenameDeviceSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Invalid request: name is required (1-100 chars)',
      400
    )
  }

  const device = await getDevice(c.env.DB, deviceId, userId)
  if (!device) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_NOT_FOUND, 'Device not found', 404)
  }

  if (device.revoked_at) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_REVOKED, 'Cannot rename a revoked device', 409)
  }

  await updateDevice(c.env.DB, deviceId, userId, { name: parsed.data.name })

  return c.json({ success: true, device: { id: deviceId, name: parsed.data.name } })
})
