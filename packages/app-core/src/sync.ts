import fs from 'node:fs/promises'
import path from 'node:path'
import { asc, desc, eq, sql } from 'drizzle-orm'
import {
  settings,
  syncDevices,
  syncHistory,
  syncQueue,
  syncState
} from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import { getMemryDir, type VaultConfig } from './paths.ts'

const maxAttempts = 5
const quarantineMaxAttempts = 3
const syncPausedKey = 'syncPaused'
const lastSyncAtKey = 'lastSyncAt'
const syncedSettingsKey = 'synced_settings'
const quarantinedItemsKey = 'quarantinedItems'

export interface SyncStatusRecord {
  status: 'idle' | 'paused'
  pendingCount: number
  lastSyncAt?: number
}

export interface SyncQueueStats {
  pending: number
  failed: number
  deadLetter: number
  total: number
}

export interface SyncHistoryResult {
  entries: Array<{
    id: string
    type: string
    itemCount: number
    direction: string | null
    details: unknown
    durationMs: number | null
    createdAt: number
  }>
  total: number
}

export interface SyncDevicesResult {
  devices: Array<{
    id: string
    name: string
    platform: string
    linkedAt: number
    lastSyncAt: number | undefined
    isCurrentDevice: boolean
  }>
  email: string | undefined
}

export interface SyncStorageBreakdown {
  used: number
  limit: number
  breakdown: {
    notes: number
    attachments: number
    crdt: number
    other: number
  }
}

export interface QuarantinedItemRecord {
  itemId: string
  itemType: string
  signerDeviceId: string
  failedAt: number
  attemptCount: number
  lastError: string
  permanent: boolean
}

export interface SyncService {
  status(): Promise<SyncStatusRecord>
  queueSize(): Promise<SyncQueueStats>
  history(options?: { limit?: number; offset?: number }): Promise<SyncHistoryResult>
  devices(): Promise<SyncDevicesResult>
  pause(): Promise<{ success: boolean; wasPaused: boolean }>
  resume(): Promise<{ success: boolean; pendingCount: number }>
  getSyncedSettings(): Promise<Record<string, unknown> | null>
  updateSyncedSetting(fieldPath: string, value: unknown): Promise<{ success: boolean }>
  storageBreakdown(): Promise<SyncStorageBreakdown>
  quarantinedItems(): Promise<QuarantinedItemRecord[]>
  checkDeviceStatus(): Promise<{ status: 'unknown' }>
}

function toMillis(value: Date | number | null): number | undefined {
  if (value === null) return undefined
  if (value instanceof Date) return value.getTime()
  return value
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function getStateValue(dataDb: DataDb, key: string): string | undefined {
  return dataDb.select().from(syncState).where(eq(syncState.key, key)).get()?.value
}

function setStateValue(dataDb: DataDb, key: string, value: string): void {
  dataDb
    .insert(syncState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value, updatedAt: new Date() }
    })
    .run()
}

function countWhere(dataDb: DataDb, where: ReturnType<typeof sql>): number {
  return (
    dataDb
      .select({ count: sql<number>`count(*)` })
      .from(syncQueue)
      .where(where)
      .get()?.count ?? 0
  )
}

function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]
    if (!part) continue
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  const last = path.at(-1)
  if (last) current[last] = value
}

async function directorySize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.stat(targetPath)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    const entries = await fs.readdir(targetPath)
    const sizes = await Promise.all(
      entries.map((entry) => directorySize(path.join(targetPath, entry)))
    )
    return sizes.reduce((total, size) => total + size, 0)
  } catch {
    return 0
  }
}

function parseQuarantinedItems(value: string | undefined): QuarantinedItemRecord[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): QuarantinedItemRecord[] => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<QuarantinedItemRecord>
      if (
        typeof candidate.itemId !== 'string' ||
        typeof candidate.itemType !== 'string' ||
        typeof candidate.signerDeviceId !== 'string' ||
        typeof candidate.failedAt !== 'number' ||
        typeof candidate.attemptCount !== 'number' ||
        typeof candidate.lastError !== 'string'
      ) {
        return []
      }
      return [
        {
          itemId: candidate.itemId,
          itemType: candidate.itemType,
          signerDeviceId: candidate.signerDeviceId,
          failedAt: candidate.failedAt,
          attemptCount: candidate.attemptCount,
          lastError: candidate.lastError,
          permanent: candidate.permanent ?? candidate.attemptCount >= quarantineMaxAttempts
        }
      ]
    })
  } catch {
    return []
  }
}

export function createSyncService({
  dataDb,
  vaultPath,
  config
}: {
  dataDb: DataDb
  vaultPath: string
  config: VaultConfig
}): SyncService {
  return {
    async status() {
      const queue = await this.queueSize()
      const lastSyncAt = getStateValue(dataDb, lastSyncAtKey)
      return {
        status: getStateValue(dataDb, syncPausedKey) === 'true' ? 'paused' : 'idle',
        pendingCount: queue.pending + queue.failed,
        ...(lastSyncAt ? { lastSyncAt: Number(lastSyncAt) } : {})
      }
    },

    async queueSize() {
      return {
        pending: countWhere(dataDb, sql`${syncQueue.attempts} = 0`),
        failed: countWhere(
          dataDb,
          sql`${syncQueue.attempts} > 0 AND ${syncQueue.attempts} < ${maxAttempts}`
        ),
        deadLetter: countWhere(dataDb, sql`${syncQueue.attempts} >= ${maxAttempts}`),
        total: dataDb.select().from(syncQueue).all().length
      }
    },

    async history(options = {}) {
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      const rows = dataDb
        .select()
        .from(syncHistory)
        .orderBy(desc(syncHistory.createdAt))
        .limit(limit)
        .offset(offset)
        .all()
      return {
        entries: rows.map((entry) => ({
          id: entry.id,
          type: entry.type,
          itemCount: entry.itemCount,
          direction: entry.direction,
          details: parseJson(entry.details),
          durationMs: entry.durationMs,
          createdAt: toMillis(entry.createdAt) ?? 0
        })),
        total: dataDb.select().from(syncHistory).all().length
      }
    },

    async devices() {
      return {
        devices: dataDb
          .select()
          .from(syncDevices)
          .orderBy(asc(syncDevices.linkedAt))
          .all()
          .map((device) => ({
            id: device.id,
            name: device.name,
            platform: device.platform,
            linkedAt: toMillis(device.linkedAt) ?? 0,
            lastSyncAt: toMillis(device.lastSyncAt),
            isCurrentDevice: device.isCurrentDevice
          })),
        email: undefined
      }
    },

    async pause() {
      const wasPaused = getStateValue(dataDb, syncPausedKey) === 'true'
      setStateValue(dataDb, syncPausedKey, 'true')
      return { success: true, wasPaused }
    },

    async resume() {
      setStateValue(dataDb, syncPausedKey, 'false')
      const queue = await this.queueSize()
      return { success: true, pendingCount: queue.pending + queue.failed }
    },

    async getSyncedSettings() {
      const row = dataDb.select().from(settings).where(eq(settings.key, syncedSettingsKey)).get()
      if (!row) return null
      const parsed = parseJson(row.value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    },

    async updateSyncedSetting(fieldPath, value) {
      const current = (await this.getSyncedSettings()) ?? {}
      setNestedValue(current, fieldPath.split('.'), value)
      const serialized = JSON.stringify(current)
      const modifiedAt = new Date().toISOString()
      dataDb
        .insert(settings)
        .values({ key: syncedSettingsKey, value: serialized, modifiedAt })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: serialized, modifiedAt }
        })
        .run()
      return { success: true }
    },

    async storageBreakdown() {
      const notes = await directorySize(path.join(vaultPath, config.defaultNoteFolder))
      const journal = await directorySize(path.join(vaultPath, config.journalFolder))
      const attachments = await directorySize(path.join(vaultPath, config.attachmentsFolder))
      const crdt = await directorySize(path.join(getMemryDir(vaultPath), 'crdt'))
      const memry = await directorySize(getMemryDir(vaultPath))
      const other = Math.max(0, memry - crdt)
      return {
        used: notes + journal + attachments + crdt + other,
        limit: 0,
        breakdown: {
          notes: notes + journal,
          attachments,
          crdt,
          other
        }
      }
    },

    async quarantinedItems() {
      return parseQuarantinedItems(getStateValue(dataDb, quarantinedItemsKey))
    },

    async checkDeviceStatus() {
      return { status: 'unknown' }
    }
  }
}
