import { app, BrowserWindow } from 'electron'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { createCrdtSyncAdapter, createSyncAdapterRegistry } from '@memry/sync-core'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { getDatabase, type DrizzleDb } from '../database'
import { createLogger } from '../lib/logger'
import {
  getDevicePublicKey as deriveDevicePublicKey,
  getOrDeriveVaultKey,
  retrieveKey,
  secureCleanup
} from '../crypto'
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
import { getRemoteSyncAdapter } from './item-handlers'
import { getIndexDatabase } from '../database/client'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getDeviceSigningKey } from './device-keys'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { CrdtUpdateQueue } from './crdt-queue'
import { recoverDirtyItems } from './dirty-recovery'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { postToServer, pushCrdtSnapshot, SyncServerError } from './http-client'
import { EVENT_CHANNELS, type SyncStatusChangedEvent } from '@memry/contracts/ipc-events'
import { withRetry } from './retry'
import {
  emitSessionExpired,
  getValidAccessToken,
  refreshAccessToken,
  retrieveToken,
  setOnTokenRefreshed
} from './token-manager'
import { SyncWorkerBridge } from './worker-bridge'

const log = createLogger('SyncRuntime')

interface SyncRuntimeState {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  engine: SyncEngine
  crdtQueue: CrdtUpdateQueue
  workerBridge: SyncWorkerBridge
}

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

function emitQuotaExceeded(): void {
  const event: SyncStatusChangedEvent = {
    status: 'error',
    pendingCount: 0,
    error: 'Storage quota exceeded',
    errorCategory: 'storage_quota_exceeded'
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNELS.STATUS_CHANGED, event)
  }
}

let runtime: SyncRuntimeState | null = null
let startPromise: Promise<SyncEngine | null> | null = null
let seedAbortController: AbortController | null = null
let seedPromise: Promise<void> | null = null

function resetSyncServiceSingletons(): void {
  resetTaskSyncService()
  resetInboxSyncService()
  resetFilterSyncService()
  resetProjectSyncService()
  resetSettingsSyncManager()
  resetNoteSyncService()
  resetJournalSyncService()
  resetTagDefinitionSyncService()
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

export function getCrdtQueue(): CrdtUpdateQueue | null {
  return runtime?.crdtQueue ?? null
}

export function getNetworkMonitor(): NetworkMonitor | null {
  return runtime?.network ?? null
}

async function seedExistingCrdtDocs(
  crdtProvider: ReturnType<typeof getCrdtProvider>,
  signal?: AbortSignal
): Promise<void> {
  const indexDb = getIndexDatabase()
  const rows = indexDb
    .select({
      id: noteCache.id,
      title: noteCache.title,
      date: noteCache.date
    })
    .from(noteCache)
    .where(eq(noteCache.fileType, 'markdown'))
    .all()

  if (rows.length === 0) return

  const entries = rows.map((r) => ({
    id: r.id,
    title: r.title,
    date: r.date ?? undefined
  }))

  const seeded = await crdtProvider.seedExistingDocs(entries, undefined, signal)
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
      const queue = new SyncQueueManager(db)
      type RuntimeSyncDb = SyncEngineDeps['db'] & Parameters<typeof initTaskSyncService>[0]['db']
      const runtimeSyncDb = db as unknown as RuntimeSyncDb

      const getDeviceId = (): string | null => getCurrentDeviceId(db)

      const taskSync = initTaskSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const inboxSync = initInboxSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const filterSync = initFilterSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const projectSync = initProjectSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const settingsSync = initSettingsSyncManager({ db: runtimeSyncDb, queue, getDeviceId })
      const noteSync = initNoteSyncService({ queue, getDeviceId })
      const journalSync = initJournalSyncService({ queue, getDeviceId })
      const tagDefinitionSync = initTagDefinitionSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })

      const adapters = createSyncAdapterRegistry([
        { type: 'task', kind: 'record', local: taskSync, remote: getRemoteSyncAdapter('task') },
        { type: 'inbox', kind: 'record', local: inboxSync, remote: getRemoteSyncAdapter('inbox') },
        {
          type: 'filter',
          kind: 'record',
          local: filterSync,
          remote: getRemoteSyncAdapter('filter')
        },
        {
          type: 'project',
          kind: 'record',
          local: projectSync,
          remote: getRemoteSyncAdapter('project')
        },
        {
          type: 'settings',
          kind: 'record',
          local: settingsSync,
          remote: getRemoteSyncAdapter('settings')
        },
        {
          type: 'note',
          kind: 'crdt',
          local: noteSync,
          remote: getRemoteSyncAdapter('note'),
          crdt: createCrdtSyncAdapter('note', { documentContentOnly: true })
        },
        {
          type: 'journal',
          kind: 'record',
          local: journalSync,
          remote: getRemoteSyncAdapter('journal')
        },
        {
          type: 'tag_definition',
          kind: 'record',
          local: tagDefinitionSync,
          remote: getRemoteSyncAdapter('tag_definition')
        }
      ])

      const crdtQueue = new CrdtUpdateQueue()
      setOnTokenRefreshed(() => crdtQueue.resume())
      crdtQueue.start(async (noteId, updates) => {
        const token = await getValidAccessToken()
        const vaultKey = await getOrDeriveVaultKey().catch(() => null)
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) return

        try {
          const b64Updates = updates.map((raw) => {
            const encrypted = encryptCrdtUpdate(raw, vaultKey, noteId, signingSecretKey)
            return Buffer.from(encrypted).toString('base64')
          })

          const MAX_CRDT_PAYLOAD_BYTES = 900_000
          const estimatedBytes = b64Updates.reduce((sum, s) => sum + s.length, 0) + 128
          if (estimatedBytes > MAX_CRDT_PAYLOAD_BYTES) {
            log.warn('CRDT payload exceeds size limit, dropping batch', {
              noteId,
              estimatedBytes,
              updateCount: b64Updates.length
            })
            return
          }

          await withRetry(
            () => postToServer('/sync/crdt/updates', { noteId, updates: b64Updates }, token),
            { maxRetries: 3, baseDelayMs: 2000 }
          )
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            crdtQueue.pause()
            emitSessionExpired()
          }
          if (err instanceof SyncServerError && err.statusCode === 413) {
            crdtQueue.pause()
            emitQuotaExceeded()
          }
          throw err
        } finally {
          secureCleanup(vaultKey)
          secureCleanup(signingSecretKey)
        }
      })

      const snapshotPushFn = async (noteId: string, state: Uint8Array): Promise<void> => {
        const token = await getValidAccessToken()
        const vaultKey = await getOrDeriveVaultKey().catch(() => null)
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
          await withRetry(() => pushCrdtSnapshot(noteId, encrypted, token), {
            maxRetries: 3,
            baseDelayMs: 2000
          })
          log.debug('Pushed CRDT snapshot', { noteId, size: state.byteLength })
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            crdtQueue.pause()
            emitSessionExpired()
          }
          if (err instanceof SyncServerError && err.statusCode === 413) {
            crdtQueue.pause()
            emitQuotaExceeded()
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

      const workerBridge = new SyncWorkerBridge()
      await workerBridge.start()

      const network = new NetworkMonitor()
      network.start()

      const ws = new WebSocketManager({
        getAccessToken: () => getValidAccessToken(),
        getAppVersion: () => app.getVersion(),
        isOnline: () => network.online,
        serverUrl: SYNC_SERVER_URL
      })

      const engine = new SyncEngine({
        queue,
        network,
        ws,
        db: runtimeSyncDb,
        getAccessToken: () => getValidAccessToken(),
        getVaultKey: () => getOrDeriveVaultKey().catch(() => null),
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
          return getDeviceSigningKey(runtimeSyncDb, deviceId, token)
        },
        emitToRenderer: emitFn,
        adapters,
        crdtProvider,
        workerBridge,
        refreshAccessToken: () => refreshAccessToken()
      })

      queue.setOnItemEnqueued(() => engine.requestPush())

      recoverDirtyItems(runtimeSyncDb, adapters)

      pendingRuntime = { queue, network, ws, engine, crdtQueue, workerBridge }
      runtime = pendingRuntime

      seedAbortController = new AbortController()

      await engine.start()
      log.info('Sync runtime started')

      seedPromise = seedExistingCrdtDocs(crdtProvider, seedAbortController.signal).catch((err) => {
        log.warn('Post-engine CRDT seed failed (non-fatal)', err)
      })

      return engine
    } catch (error) {
      if (pendingRuntime) {
        pendingRuntime.crdtQueue.stop()
        pendingRuntime.ws.disconnect()
        pendingRuntime.network.stop()
        await pendingRuntime.workerBridge.stop().catch(() => {})
        await pendingRuntime.engine.stop().catch(() => {})
      }
      await getCrdtProvider()
        .destroy()
        .catch((err) => {
          log.error('Failed to destroy CrdtProvider after startup failure', err)
        })
      resetCrdtProvider()

      runtime = null
      resetSyncServiceSingletons()
      log.error('Failed to start sync runtime', error)
      return null
    } finally {
      startPromise = null
    }
  })()

  return startPromise
}

export async function stopSyncRuntime(options?: { skipFinalSync?: boolean }): Promise<void> {
  if (startPromise) {
    await startPromise.catch(() => {})
  }

  if (seedAbortController) {
    seedAbortController.abort()
    seedAbortController = null
  }
  if (seedPromise) {
    await seedPromise.catch(() => {})
    seedPromise = null
  }

  const active = runtime

  if (active && !options?.skipFinalSync) {
    try {
      const pushed = await getCrdtProvider().pushAllSnapshots()
      if (pushed > 0) log.info(`Pushed ${pushed} CRDT snapshot(s) before shutdown`)
    } catch (err) {
      log.warn('Pre-shutdown CRDT snapshot push failed', err)
    }
  }

  runtime = null
  startPromise = null

  resetSyncServiceSingletons()

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
    await active.engine.stop({ skipFinalPush: options?.skipFinalSync })
  } catch (error) {
    log.error('Failed to stop sync engine cleanly', error)
  }

  active.crdtQueue.stop()
  await active.workerBridge.stop().catch((err) => {
    log.error('Failed to stop sync worker', err)
  })
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
