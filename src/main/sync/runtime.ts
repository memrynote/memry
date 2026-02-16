import { BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'
import { KEYCHAIN_ENTRIES } from '@shared/contracts/crypto'
import { syncDevices } from '@shared/db/schema/sync-devices'
import { getDatabase, type DrizzleDb } from '../database'
import { createLogger } from '../lib/logger'
import { getDevicePublicKey as deriveDevicePublicKey, retrieveKey, secureCleanup } from '../crypto'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { SyncQueueManager } from './queue'
import { NetworkMonitor } from './network'
import { WebSocketManager } from './websocket'
import { initTaskSyncService, resetTaskSyncService } from './task-sync'
import { initInboxSyncService, resetInboxSyncService } from './inbox-sync'
import { initFilterSyncService, resetFilterSyncService } from './filter-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from './settings-sync'
import { getDeviceSigningKey } from './device-keys'

const log = createLogger('SyncRuntime')

interface SyncRuntimeState {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  engine: SyncEngine
}

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

let runtime: SyncRuntimeState | null = null
let startPromise: Promise<SyncEngine | null> | null = null

async function retrieveToken(
  entry: (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES]
): Promise<string | null> {
  const encoded = await retrieveKey(entry)
  if (!encoded) return null
  return new TextDecoder().decode(encoded)
}

function getCurrentDeviceId(db: DrizzleDb): string | null {
  const device = db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(eq(syncDevices.isCurrentDevice, true))
    .get()
  return device?.id ?? null
}

export function getSyncEngine(): SyncEngine | null {
  return runtime?.engine ?? null
}

export async function startSyncRuntime(): Promise<SyncEngine | null> {
  if (runtime) return runtime.engine
  if (startPromise) return startPromise

  startPromise = (async () => {
    let pendingRuntime: SyncRuntimeState | null = null

    try {
      const db = getDatabase()
      const queue = new SyncQueueManager(
        db as unknown as ConstructorParameters<typeof SyncQueueManager>[0]
      )
      const getDeviceId = (): string | null => getCurrentDeviceId(db)
      const serviceDb = db as unknown as Parameters<typeof initTaskSyncService>[0]['db']
      const settingsDb = db as unknown as Parameters<typeof initSettingsSyncManager>[0]['db']
      const engineDb = db as unknown as SyncEngineDeps['db']

      initTaskSyncService({ queue, db: serviceDb, getDeviceId })
      initInboxSyncService({ queue, db: serviceDb, getDeviceId })
      initFilterSyncService({ queue, db: serviceDb, getDeviceId })
      initSettingsSyncManager({ db: settingsDb, queue, getDeviceId })

      const network = new NetworkMonitor()
      network.start()

      const ws = new WebSocketManager({
        getAccessToken: () => retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN),
        isOnline: () => network.online,
        serverUrl: SYNC_SERVER_URL
      })

      const engine = new SyncEngine({
        queue,
        network,
        ws,
        db: engineDb,
        getAccessToken: () => retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN),
        getVaultKey: () => retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY),
        getSigningKeys: async () => {
          const secretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
          if (!secretKey) return null

          const deviceId = getCurrentDeviceId(db)
          if (!deviceId) {
            secureCleanup(secretKey)
            return null
          }

          return {
            secretKey,
            publicKey: deriveDevicePublicKey(secretKey),
            deviceId
          }
        },
        getDevicePublicKey: async (deviceId) => {
          const currentDeviceId = getCurrentDeviceId(db)

          if (currentDeviceId && deviceId === currentDeviceId) {
            const secretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
            if (!secretKey) return null
            try {
              return deriveDevicePublicKey(secretKey)
            } finally {
              secureCleanup(secretKey)
            }
          }

          const token = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
          if (!token) return null
          return getDeviceSigningKey(engineDb, deviceId, token)
        },
        emitToRenderer: (channel, data) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(channel, data)
          }
        }
      })

      queue.setOnItemEnqueued(() => engine.requestPush())

      pendingRuntime = { queue, network, ws, engine }
      runtime = pendingRuntime
      await engine.start()
      log.info('Sync runtime started')
      return engine
    } catch (error) {
      if (pendingRuntime) {
        pendingRuntime.ws.disconnect()
        pendingRuntime.network.stop()
        await pendingRuntime.engine.stop().catch(() => {})
      }

      runtime = null
      resetTaskSyncService()
      resetInboxSyncService()
      resetFilterSyncService()
      resetSettingsSyncManager()
      log.error('Failed to start sync runtime', error)
      return null
    } finally {
      startPromise = null
    }
  })()

  return startPromise
}

export async function stopSyncRuntime(): Promise<void> {
  const active = runtime
  runtime = null
  startPromise = null

  resetTaskSyncService()
  resetInboxSyncService()
  resetFilterSyncService()
  resetSettingsSyncManager()

  if (!active) return

  try {
    await active.engine.stop()
  } catch (error) {
    log.error('Failed to stop sync engine cleanly', error)
  }

  active.ws.disconnect()
  active.network.stop()
  log.info('Sync runtime stopped')
}
