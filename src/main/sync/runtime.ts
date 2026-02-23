import { BrowserWindow } from 'electron'
import sodium from 'libsodium-wrappers-sumo'
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
import { initProjectSyncService, resetProjectSyncService } from './project-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from './settings-sync'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { initJournalSyncService, resetJournalSyncService } from './journal-sync'
import { initTagDefinitionSyncService, resetTagDefinitionSyncService } from './tag-definition-sync'
import { getIndexDatabase } from '../database/client'
import { noteCache } from '@shared/db/schema/notes-cache'
import { getDeviceSigningKey } from './device-keys'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { CrdtUpdateQueue } from './crdt-queue'
import { recoverDirtyItems } from './dirty-recovery'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { postToServer, pushCrdtSnapshot, SyncServerError } from './http-client'
import { getValidAccessToken, retrieveToken, setOnTokenRefreshed } from './token-manager'

const log = createLogger('SyncRuntime')

interface SyncRuntimeState {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  engine: SyncEngine
  crdtQueue: CrdtUpdateQueue
}

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

let runtime: SyncRuntimeState | null = null
let startPromise: Promise<SyncEngine | null> | null = null

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

export function getCrdtQueue(): CrdtUpdateQueue | null {
  return runtime?.crdtQueue ?? null
}

async function seedExistingCrdtDocs(
  crdtProvider: ReturnType<typeof getCrdtProvider>
): Promise<void> {
  const indexDb = getIndexDatabase()
  const rows = indexDb
    .select({
      id: noteCache.id,
      title: noteCache.title,
      date: noteCache.date
    })
    .from(noteCache)
    .all()

  if (rows.length === 0) return

  const entries = rows.map((r) => ({
    id: r.id,
    title: r.title,
    date: r.date ?? undefined
  }))

  const seeded = await crdtProvider.seedExistingDocs(entries)
  if (seeded > 0) {
    log.info('Initial CRDT seed complete', { seeded, total: entries.length })
  }
}

export async function startSyncRuntime(): Promise<SyncEngine | null> {
  if (runtime) return runtime.engine
  if (startPromise) return startPromise

  const hasRefreshToken = await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  if (!hasRefreshToken) {
    log.debug('Sync runtime skipped: no user session')
    return null
  }

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
      initProjectSyncService({ queue, db: serviceDb, getDeviceId })
      initSettingsSyncManager({ db: settingsDb, queue, getDeviceId })
      initNoteSyncService({ queue, getDeviceId })
      initJournalSyncService({ queue, getDeviceId })
      initTagDefinitionSyncService({ queue, db: serviceDb, getDeviceId })

      const crdtQueue = new CrdtUpdateQueue()
      setOnTokenRefreshed(() => crdtQueue.resume())
      crdtQueue.start(async (noteId, updates) => {
        const token = await getValidAccessToken()
        const vaultKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) return

        try {
          const b64Updates = updates.map((raw) => {
            const encrypted = encryptCrdtUpdate(raw, vaultKey, noteId, signingSecretKey)
            return btoa(String.fromCharCode(...encrypted))
          })
          await postToServer('/sync/crdt/updates', { noteId, updates: b64Updates }, token)
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            crdtQueue.pause()
          }
          throw err
        } finally {
          secureCleanup(vaultKey)
          secureCleanup(signingSecretKey)
        }
      })

      const snapshotPushFn = async (noteId: string, state: Uint8Array): Promise<void> => {
        const token = await getValidAccessToken()
        const vaultKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) {
          log.warn('Missing credentials for CRDT snapshot push', {
            noteId,
            hasToken: !!token,
            hasVaultKey: !!vaultKey,
            hasSigningKey: !!signingSecretKey
          })
          if (vaultKey) secureCleanup(vaultKey)
          if (signingSecretKey) secureCleanup(signingSecretKey)
          throw new Error('Missing credentials for CRDT snapshot push')
        }

        try {
          const encrypted = encryptCrdtUpdate(state, vaultKey, noteId, signingSecretKey)
          await pushCrdtSnapshot(noteId, encrypted, token)
          log.debug('Pushed CRDT snapshot', { noteId, size: state.byteLength })
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            crdtQueue.pause()
          }
          throw err
        } finally {
          secureCleanup(vaultKey)
          secureCleanup(signingSecretKey)
        }
      }

      const crdtProvider = getCrdtProvider()
      await crdtProvider.init(crdtQueue, snapshotPushFn)

      const emitFn = (channel: string, data: unknown): void => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(channel, data)
        }
      }

      const network = new NetworkMonitor()
      network.start()

      const ws = new WebSocketManager({
        getAccessToken: () => getValidAccessToken(),
        isOnline: () => network.online,
        serverUrl: SYNC_SERVER_URL
      })

      const engine = new SyncEngine({
        queue,
        network,
        ws,
        db: engineDb,
        getAccessToken: () => getValidAccessToken(),
        getVaultKey: () => retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY),
        getSigningKeys: async () => {
          const secretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
          if (!secretKey) return null

          const deviceId = getCurrentDeviceId(db)
          if (!deviceId) {
            secureCleanup(secretKey)
            return null
          }

          const publicKey = deriveDevicePublicKey(secretKey)

          const device = db
            .select({ signingPublicKey: syncDevices.signingPublicKey })
            .from(syncDevices)
            .where(eq(syncDevices.isCurrentDevice, true))
            .get()

          if (device?.signingPublicKey) {
            const derivedB64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
            if (device.signingPublicKey !== derivedB64) {
              log.warn('Signing key mismatch detected at runtime — self-healing DB', {
                deviceId
              })
              db.update(syncDevices)
                .set({ signingPublicKey: derivedB64 })
                .where(eq(syncDevices.isCurrentDevice, true))
                .run()
            }
          }

          return { secretKey, publicKey, deviceId }
        },
        getDevicePublicKey: async (deviceId) => {
          const token = await getValidAccessToken()
          if (!token) return null
          return getDeviceSigningKey(engineDb, deviceId, token)
        },
        emitToRenderer: emitFn,
        crdtProvider
      })

      queue.setOnItemEnqueued(() => engine.requestPush())

      recoverDirtyItems(db as unknown as Parameters<typeof recoverDirtyItems>[0])

      pendingRuntime = { queue, network, ws, engine, crdtQueue }
      runtime = pendingRuntime
      await engine.start()
      log.info('Sync runtime started')

      seedExistingCrdtDocs(crdtProvider).catch((err) => {
        log.warn('CRDT seed failed (non-fatal)', err)
      })

      return engine
    } catch (error) {
      if (pendingRuntime) {
        pendingRuntime.crdtQueue.stop()
        pendingRuntime.ws.disconnect()
        pendingRuntime.network.stop()
        await pendingRuntime.engine.stop().catch(() => {})
      }
      await getCrdtProvider()
        .destroy()
        .catch((err) => {
          log.error('Failed to destroy CrdtProvider after startup failure', err)
        })
      resetCrdtProvider()

      runtime = null
      resetTaskSyncService()
      resetInboxSyncService()
      resetFilterSyncService()
      resetProjectSyncService()
      resetSettingsSyncManager()
      resetNoteSyncService()
      resetJournalSyncService()
      resetTagDefinitionSyncService()
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

  if (active) {
    try {
      const pushed = await getCrdtProvider().pushAllSnapshots()
      if (pushed > 0) log.info(`Pushed ${pushed} CRDT snapshot(s) before shutdown`)
    } catch (err) {
      log.warn('Pre-shutdown CRDT snapshot push failed', err)
    }
  }

  runtime = null
  startPromise = null

  resetTaskSyncService()
  resetInboxSyncService()
  resetFilterSyncService()
  resetProjectSyncService()
  resetSettingsSyncManager()
  resetNoteSyncService()
  resetJournalSyncService()
  resetTagDefinitionSyncService()

  if (!active) {
    await getCrdtProvider()
      .destroy()
      .catch((err) => {
        log.error('Failed to destroy CrdtProvider while runtime inactive', err)
      })
    resetCrdtProvider()
    return
  }

  try {
    await active.engine.stop()
  } catch (error) {
    log.error('Failed to stop sync engine cleanly', error)
  }

  active.crdtQueue.stop()
  await getCrdtProvider()
    .destroy()
    .catch((err) => {
      log.error('Failed to destroy CrdtProvider', err)
    })
  resetCrdtProvider()
  active.ws.disconnect()
  active.network.stop()
  log.info('Sync runtime stopped')
}
