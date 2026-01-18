/**
 * Device Service
 *
 * Handles CRUD operations for linked devices in D1 database.
 * Used by auth routes for device registration and management.
 *
 * @module services/device
 */

import { NotFoundError, ValidationError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/**
 * Device record from D1 database
 */
export interface Device {
  id: string
  user_id: string
  name: string
  platform: string
  os_version: string | null
  app_version: string
  auth_public_key: string | null
  push_token: string | null
  created_at: number
  last_sync_at: number | null
  revoked_at: number | null
}

/**
 * Device registration input
 */
export interface RegisterDeviceInput {
  userId: string
  name: string
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  osVersion?: string
  appVersion: string
  authPublicKey?: string
}

/**
 * Public device data (safe to return to client)
 */
export interface DevicePublic {
  id: string
  name: string
  platform: string
  osVersion?: string
  appVersion: string
  createdAt: string
  lastSyncAt?: string
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum devices per user */
const MAX_DEVICES_PER_USER = 10

/** Valid platforms */
const VALID_PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android'] as const

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a unique ID for devices
 */
function generateId(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Convert database device to public device
 */
export function toPublicDevice(device: Device): DevicePublic {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    osVersion: device.os_version || undefined,
    appVersion: device.app_version,
    createdAt: new Date(device.created_at).toISOString(),
    lastSyncAt: device.last_sync_at ? new Date(device.last_sync_at).toISOString() : undefined
  }
}

// =============================================================================
// Device Service Functions
// =============================================================================

/**
 * Register a new device for a user.
 *
 * @param db - D1 database instance
 * @param input - Device registration data
 * @returns Created device
 * @throws ValidationError if device limit reached or invalid platform
 */
export async function registerDevice(db: D1Database, input: RegisterDeviceInput): Promise<Device> {
  // Validate platform
  if (!VALID_PLATFORMS.includes(input.platform)) {
    throw new ValidationError(`Invalid platform: ${input.platform}`)
  }

  // Check device count
  const countResult = await db
    .prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ? AND revoked_at IS NULL')
    .bind(input.userId)
    .first<{ count: number }>()

  if (countResult && countResult.count >= MAX_DEVICES_PER_USER) {
    throw new ValidationError(`Device limit reached (maximum ${MAX_DEVICES_PER_USER} devices)`)
  }

  const now = Date.now()
  const id = generateId()

  await db
    .prepare(
      `INSERT INTO devices (
        id, user_id, name, platform, os_version, app_version,
        auth_public_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.userId,
      input.name,
      input.platform,
      input.osVersion || null,
      input.appVersion,
      input.authPublicKey || null,
      now
    )
    .run()

  return (await getDeviceById(db, id))!
}

/**
 * Get device by ID.
 *
 * @param db - D1 database instance
 * @param id - Device ID
 * @returns Device or null if not found
 */
export async function getDeviceById(db: D1Database, id: string): Promise<Device | null> {
  const result = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<Device>()
  return result || null
}

/**
 * Get all active devices for a user.
 *
 * @param db - D1 database instance
 * @param userId - User ID
 * @returns List of active devices
 */
export async function getDevicesByUserId(db: D1Database, userId: string): Promise<Device[]> {
  const result = await db
    .prepare(
      'SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .bind(userId)
    .all<Device>()

  return result.results || []
}

/**
 * Update device last sync timestamp.
 *
 * @param db - D1 database instance
 * @param id - Device ID
 * @returns Updated device
 */
export async function updateDeviceLastSync(db: D1Database, id: string): Promise<Device | null> {
  const now = Date.now()

  await db.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ?').bind(now, id).run()

  return getDeviceById(db, id)
}

/**
 * Update device name.
 *
 * @param db - D1 database instance
 * @param id - Device ID
 * @param name - New device name
 * @returns Updated device
 */
export async function updateDeviceName(db: D1Database, id: string, name: string): Promise<Device> {
  const result = await db.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name, id).run()

  if (result.meta.changes === 0) {
    throw new NotFoundError('Device')
  }

  return (await getDeviceById(db, id))!
}

/**
 * Revoke (soft delete) a device.
 *
 * @param db - D1 database instance
 * @param id - Device ID
 * @returns True if device was revoked
 */
export async function revokeDevice(db: D1Database, id: string): Promise<boolean> {
  const now = Date.now()

  const result = await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, id)
    .run()

  return result.meta.changes > 0
}

/**
 * Permanently delete a device.
 *
 * @param db - D1 database instance
 * @param id - Device ID
 * @returns True if deleted
 */
export async function deleteDevice(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM devices WHERE id = ?').bind(id).run()
  return result.meta.changes > 0
}

/**
 * Count active devices for a user.
 *
 * @param db - D1 database instance
 * @param userId - User ID
 * @returns Number of active devices
 */
export async function countActiveDevices(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ? AND revoked_at IS NULL')
    .bind(userId)
    .first<{ count: number }>()

  return result?.count || 0
}
