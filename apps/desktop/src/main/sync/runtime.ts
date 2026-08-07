import { app } from 'electron'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { createCrdtSyncAdapter, createSyncAdapterRegistry } from '@memry/sync-core'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { getDatabase, type DataDb } from '../database'
import { isAppShuttingDown } from '../app-shutdown'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  getDevicePublicKey as deriveDevicePublicKey,
  getOrInitializeLocalVaultKey,
  retrieveKey,
  secureCleanup
} from '../crypto'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { resolveSyncServerUrl } from './sync-server-url'
import { syncGoogleCalendarSource } from '../calendar/google/sync-service'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { trackMainEvent } from '../telemetry/track'
import { SyncQueueManager } from './queue'
import { NetworkMonitor } from './network'
import { WebSocketManager } from './websocket'
import { initTaskSyncService, resetTaskSyncService } from './task-sync'
import { initInboxSyncService, resetInboxSyncService } from './inbox-sync'
import { initFilterSyncService, resetFilterSyncService } from './filter-sync'
import { initBookmarkSyncService, resetBookmarkSyncService } from './bookmark-sync'
import { initTemplateSyncService, resetTemplateSyncService } from './template-sync'
import { initReminderSyncService, resetReminderSyncService } from './reminder-sync'
import { initCanvasSyncService, resetCanvasSyncService } from './canvas-sync'
import { initProjectSyncService, resetProjectSyncService } from './project-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from './settings-sync'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { initJournalSyncService, resetJournalSyncService } from './journal-sync'
import { initTagDefinitionSyncService, resetTagDefinitionSyncService } from './tag-definition-sync'
import { initTagCategorySyncService, resetTagCategorySyncService } from './tag-category-sync'
import { initFolderConfigSyncService, resetFolderConfigSyncService } from './folder-config-sync'
import { initCalendarEventSyncService, resetCalendarEventSyncService } from './calendar-event-sync'
import {
  initCalendarSourceSyncService,
  resetCalendarSourceSyncService
} from './calendar-source-sync'
import {
  initCalendarBindingSyncService,
  resetCalendarBindingSyncService
} from './calendar-binding-sync'
import {
  initCalendarExternalEventSyncService,
  resetCalendarExternalEventSyncService
} from './calendar-external-event-sync'
import { getRemoteSyncAdapter } from './item-handlers'
import { getIndexDatabase } from '../database/client'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getDeviceSigningKey } from './device-keys'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { CrdtUpdateQueue } from './crdt-queue'
import { CrdtSnapshotScheduler } from './crdt-snapshot-scheduler'
import { recoverDirtyItems } from './dirty-recovery'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { postToServer, pushCrdtSnapshot, SyncServerError } from './http-client'
import {
  EVENT_CHANNELS,
  type SyncStatusChangedEvent,
  type VaultRecoveryNeededEvent
} from '@memry/contracts/ipc-events'
import { classifyVaultKeyError, vaultRecoveryReason } from '../crypto/vault-key-error'
import {
  checkLocalKeyAgainstAccount,
  isKeyMaterialActivityRecent,
  keyMaterialActivityRemainingMs
} from './key-verification'
import { withRetry } from './retry'
import { withAuthRetry, type AuthRetryDeps } from './auth-retry'
import {
  getValidAccessToken,
  refreshAccessToken,
  retrieveToken,
  setOnTokenRefreshed
} from './token-manager'
import { SyncWorkerBridge } from './worker-bridge'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { store } from '../store'

const log = createLogger('SyncRuntime')

const crdtAuthRetryDeps: AuthRetryDeps = {
  refreshAccessToken: () => refreshAccessToken(),
  getAccessToken: () => getValidAccessToken()
}

interface SyncRuntimeState {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  engine: SyncEngine
  crdtQueue: CrdtUpdateQueue
  snapshotScheduler: CrdtSnapshotScheduler
  workerBridge: SyncWorkerBridge
}

function getVerifiedVaultKey(db: DataDb): Promise<Uint8Array> {
  return getOrInitializeLocalVaultKey(db, getOrCreateVaultUuid(db))
}

function emitVaultRecoveryNeeded(event: VaultRecoveryNeededEvent): void {
  broadcastToAllWindows(EVENT_CHANNELS.VAULT_RECOVERY_NEEDED, event)
}

function emitSyncStatus(event: SyncStatusChangedEvent): void {
  broadcastToAllWindows(EVENT_CHANNELS.STATUS_CHANGED, event)
}

function emitQuotaExceeded(): void {
  emitSyncStatus({
    status: 'error',
    pendingCount: 0,
    error: 'Storage quota exceeded',
    errorCategory: 'storage_quota_exceeded'
  })
}

function emitLocalOnly(): void {
  emitSyncStatus({ status: 'local_only', pendingCount: 0 })
}

let runtime: SyncRuntimeState | null = null
let startPromise: Promise<SyncEngine | null> | null = null
let seedAbortController: AbortController | null = null
let deferredStartTimer: NodeJS.Timeout | null = null

const DEFERRED_START_GRACE_MS = 2_000

// One-shot retry for a start deferred by the key-material transition window.
// startSyncRuntime self-guards (shutdown, existing runtime, missing session),
// so a late or redundant firing is a no-op.
function scheduleDeferredStart(): void {
  if (deferredStartTimer) return
  const delay = keyMaterialActivityRemainingMs() + DEFERRED_START_GRACE_MS
  deferredStartTimer = setTimeout(() => {
    deferredStartTimer = null
    void startSyncRuntime().catch((err) => {
      log.warn('Deferred sync runtime start failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
  }, delay)
  deferredStartTimer.unref?.()
}
let seedPromise: Promise<void> | null = null
let vaultKeyFailureLogged = false
// Once per process: a confirmed account-key mismatch escalates (recovery
// prompt + sign-out) a single time, not on every failing pull cycle.
let vaultKeyMismatchHandled = false

function resetSyncServiceSingletons(): void {
  resetTaskSyncService()
  resetInboxSyncService()
  resetFilterSyncService()
  resetBookmarkSyncService()
  resetTemplateSyncService()
  resetReminderSyncService()
  resetCanvasSyncService()
  resetProjectSyncService()
  resetSettingsSyncManager()
  resetNoteSyncService()
  resetJournalSyncService()
  resetTagDefinitionSyncService()
  resetTagCategorySyncService()
  resetFolderConfigSyncService()
  resetCalendarEventSyncService()
  resetCalendarSourceSyncService()
  resetCalendarBindingSyncService()
  resetCalendarExternalEventSyncService()
}

function getCurrentDeviceId(db: DataDb): string | null {
  const device = db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(eq(syncDevices.isCurrentDevice, true))
    .get()
  return device?.id ?? null
}

async function getOptionalRuntimeVaultKey(db: DataDb, context: string): Promise<Uint8Array | null> {
  try {
    return await getVerifiedVaultKey(db)
  } catch (error) {
    if (!vaultKeyFailureLogged) {
      vaultKeyFailureLogged = true
      log.warn('Vault key unavailable for sync operation', { context, error })
    }
    return null
  }
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
  // Never spin up (or re-arm) the sync runtime once app shutdown has begun.
  // In-flight startup work or a late IPC can otherwise restart it mid-shutdown,
  // right after before-quit already stopped it. Return any existing engine so
  // callers behave as if the runtime were already up.
  if (isAppShuttingDown()) return runtime?.engine ?? null
  if (runtime) return runtime.engine
  if (startPromise) return startPromise

  startPromise = (async () => {
    let pendingRuntime: SyncRuntimeState | null = null

    try {
      const hasRefreshToken = await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
      if (!hasRefreshToken) {
        log.debug('Sync runtime skipped: no user session')
        return null
      }

      if (store.get('sync').recoveryPhraseConfirmed === false) {
        log.debug('Sync runtime skipped: recovery phrase confirmation pending')
        return null
      }

      const { resolveEntitlementForSyncStart } = await import('../billing/paddle-billing')
      const entitlement = await resolveEntitlementForSyncStart()
      if (!entitlement.isPaid) {
        log.info('Sync runtime skipped: not on a paid plan')
        emitLocalOnly()
        return null
      }

      const db = getDatabase()
      let startupVaultKey: Uint8Array | null = null
      try {
        startupVaultKey = await getVerifiedVaultKey(db)
        vaultKeyFailureLogged = false
      } catch (error) {
        log.error('Sync runtime unavailable: vault key verification failed', error)
        // A persistent mismatch (wrong or missing master key) can't be retried
        // away — prompt the user to recover the correct key instead of leaving
        // them at a generic "sync unavailable" error. A transient unreadable
        // secret is NOT surfaced here; it retries on the next healthy run.
        if (classifyVaultKeyError(error) === 'recovery-needed') {
          emitVaultRecoveryNeeded({ reason: vaultRecoveryReason(error) })
        }
        return null
      } finally {
        if (startupVaultKey) secureCleanup(startupVaultKey)
      }

      // The local vault verifier above only proves self-consistency — a fresh
      // vault binds whatever key the keychain currently holds, even a wrong
      // one. Check the key against the ACCOUNT before pulling: syncing with a
      // mismatched key fails on every item and brands them corrupt/quarantined.
      const accountKeyCheck = await checkLocalKeyAgainstAccount()
      if (accountKeyCheck === 'transition') {
        // Sign-in / recovery / linking is mid-flight; the true key lands at
        // flow finalize — but the finalize's own restart usually lands INSIDE
        // this same window and gets deferred too, leaving sync dark until an
        // unrelated trigger. Schedule one retry for just past window expiry.
        log.info('Sync runtime deferred: key material is being re-established')
        scheduleDeferredStart()
        return null
      }
      if (accountKeyCheck === 'mismatch') {
        log.error(
          'Sync runtime unavailable: local master key does not match the account — recovery required'
        )
        emitVaultRecoveryNeeded({ reason: 'vault-key-mismatch' })
        return null
      }

      // Dormant-provisioned vaults (downloaded or linked) start without a
      // current-device row; without it getSigningKeys() is null and the engine
      // never pulls. Seed it from the install-wide identity before starting.
      try {
        const { ensureDeviceRowForVault } = await import('./device-registration')
        await ensureDeviceRowForVault(db)
      } catch (error) {
        log.warn('Device row self-heal failed — sync may stay idle for this vault', error)
      }

      const queue = new SyncQueueManager(db)
      type RuntimeSyncDb = SyncEngineDeps['db'] & Parameters<typeof initTaskSyncService>[0]['db']
      const runtimeSyncDb = db as unknown as RuntimeSyncDb

      const getDeviceId = (): string | null => getCurrentDeviceId(db)

      const taskSync = initTaskSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const inboxSync = initInboxSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const filterSync = initFilterSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const bookmarkSync = initBookmarkSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const templateSync = initTemplateSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const reminderSync = initReminderSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const canvasSync = initCanvasSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const projectSync = initProjectSyncService({ queue, db: runtimeSyncDb, getDeviceId })
      const settingsSync = initSettingsSyncManager({ db: runtimeSyncDb, queue, getDeviceId })
      const noteSync = initNoteSyncService({ queue, getDeviceId })
      const journalSync = initJournalSyncService({ queue, getDeviceId })
      const tagDefinitionSync = initTagDefinitionSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const tagCategorySync = initTagCategorySyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const folderConfigSync = initFolderConfigSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const calendarEventSync = initCalendarEventSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const calendarSourceSync = initCalendarSourceSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const calendarBindingSync = initCalendarBindingSyncService({
        queue,
        db: runtimeSyncDb,
        getDeviceId
      })
      const calendarExternalEventSync = initCalendarExternalEventSyncService({
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
          type: 'bookmark',
          kind: 'record',
          local: bookmarkSync,
          remote: getRemoteSyncAdapter('bookmark')
        },
        {
          type: 'template',
          kind: 'record',
          local: templateSync,
          remote: getRemoteSyncAdapter('template')
        },
        {
          type: 'reminder',
          kind: 'record',
          local: reminderSync,
          remote: getRemoteSyncAdapter('reminder')
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
        },
        {
          type: 'tag_category',
          kind: 'record',
          local: tagCategorySync,
          remote: getRemoteSyncAdapter('tag_category')
        },
        {
          type: 'folder_config',
          kind: 'record',
          local: folderConfigSync,
          remote: getRemoteSyncAdapter('folder_config')
        },
        {
          type: 'calendar_event',
          kind: 'record',
          local: calendarEventSync,
          remote: getRemoteSyncAdapter('calendar_event')
        },
        {
          type: 'calendar_source',
          kind: 'record',
          local: calendarSourceSync,
          remote: getRemoteSyncAdapter('calendar_source')
        },
        {
          type: 'calendar_binding',
          kind: 'record',
          local: calendarBindingSync,
          remote: getRemoteSyncAdapter('calendar_binding')
        },
        {
          type: 'calendar_external_event',
          kind: 'record',
          local: calendarExternalEventSync,
          remote: getRemoteSyncAdapter('calendar_external_event')
        },
        {
          type: 'canvas',
          kind: 'record',
          local: canvasSync,
          remote: getRemoteSyncAdapter('canvas')
        }
      ])

      const crdtQueue = new CrdtUpdateQueue()
      const snapshotScheduler = new CrdtSnapshotScheduler((noteId) =>
        crdtProvider.pushSnapshotForNote(noteId)
      )
      crdtQueue.start(async (noteId, updates) => {
        let token = await getValidAccessToken()
        const vaultKey = await getOptionalRuntimeVaultKey(db, 'crdt update batch')
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) {
          if (vaultKey) secureCleanup(vaultKey)
          if (signingSecretKey) secureCleanup(signingSecretKey)
          return
        }

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
            () =>
              withAuthRetry(
                (authToken) =>
                  postToServer('/sync/crdt/updates', { noteId, updates: b64Updates }, authToken),
                token!,
                crdtAuthRetryDeps,
                (fresh) => {
                  token = fresh
                }
              ),
            { maxRetries: 3, baseDelayMs: 2000 }
          )

          // The incremental batch is already durable on the server; the full
          // snapshot is only a compaction point, so it rides a long debounce
          // instead of re-encoding the whole document every flush.
          snapshotScheduler.request(noteId)
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            // withAuthRetry already attempted a refresh. Pause so the
            // re-buffered batch waits for the next successful refresh
            // (setOnTokenRefreshed resumes the queue); token-manager owns the
            // session-expired toast for terminal refresh failures.
            crdtQueue.pause()
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
        let token = await getValidAccessToken()
        const vaultKey = await getOptionalRuntimeVaultKey(db, 'crdt snapshot push')
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) {
          log.warn('Missing credentials for CRDT snapshot push', {
            noteId,
            authAvailable: !!token,
            hasVaultKey: !!vaultKey,
            hasSigningKey: !!signingSecretKey
          })
          if (vaultKey) secureCleanup(vaultKey)
          if (signingSecretKey) secureCleanup(signingSecretKey)
          throw new Error('Missing credentials for CRDT snapshot push')
        }

        try {
          const encrypted = encryptCrdtUpdate(state, vaultKey, noteId, signingSecretKey)
          await withRetry(
            () =>
              withAuthRetry(
                (authToken) => pushCrdtSnapshot(noteId, encrypted, authToken),
                token!,
                crdtAuthRetryDeps,
                (fresh) => {
                  token = fresh
                }
              ),
            {
              maxRetries: 3,
              baseDelayMs: 2000
            }
          )
          log.debug('Pushed CRDT snapshot', { noteId, size: state.byteLength })
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            // withAuthRetry already attempted a refresh — see the update-batch
            // handler above. The caller keeps pendingSnapshotBytes, so the
            // snapshot re-pushes after the queue resumes.
            crdtQueue.pause()
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
        broadcastToAllWindows(channel, data)
      }

      const workerBridge = new SyncWorkerBridge()
      try {
        await workerBridge.start()
      } catch (err) {
        // Worker init failure must not take down sync: sync-crypto-batch
        // checks workerBridge.isRunning per batch and also catches a rejected
        // worker request (protocol drift, timeout, worker error/exit), falling
        // back to main-thread crypto in either case.
        log.error('Sync worker failed to start — continuing with main-thread crypto', err)
      }

      const network = new NetworkMonitor()
      network.start()
      if (!network.online) {
        crdtQueue.pause()
      }
      network.on('status-changed', ({ online }: { online: boolean }) => {
        if (online) {
          crdtQueue.resume()
        } else {
          crdtQueue.pause()
        }
      })
      const ws = new WebSocketManager({
        getAccessToken: () => getValidAccessToken(),
        getAppVersion: () => app.getVersion(),
        isOnline: () => network.online,
        serverUrl: resolveSyncServerUrl()
      })

      setOnTokenRefreshed(() => {
        if (network.online) {
          crdtQueue.resume()
        }
        // Hand the fresh token to the live socket so the server extends it in
        // place instead of dropping it with WS_TOKEN_EXPIRED at expiry.
        void ws.refreshAuth()
      })

      const engine = new SyncEngine({
        queue,
        network,
        ws,
        db: runtimeSyncDb,
        getAccessToken: () => getValidAccessToken(),
        getVaultKey: () => getOptionalRuntimeVaultKey(db, 'sync engine'),
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
        refreshAccessToken: () => refreshAccessToken(),
        calendarSyncOneSource: (sourceId) => {
          void syncGoogleCalendarSource(runtimeSyncDb, sourceId).catch((err) => {
            log.warn('calendarSyncOneSource failed', { sourceId, err })
          })
        },
        checkAccountKey: () => checkLocalKeyAgainstAccount(),
        onVaultKeyMismatch: () => {
          // Only reached on a CONFIRMED mismatch ('transition' never escalates
          // — see checkAccountKey). Guard the rare race where a key-material
          // flow started between the check and this callback.
          if (vaultKeyMismatchHandled) return
          vaultKeyMismatchHandled = true
          emitVaultRecoveryNeeded({ reason: 'vault-key-mismatch' })
          if (isKeyMaterialActivityRecent()) {
            log.info('Vault key mismatch during key-material transition — not tearing down')
            return
          }
          // Steady-state confirmed mismatch: this session can never sync. Sign
          // the user out so the normal sign-in + recovery-phrase flow restores
          // the correct key (session-teardown imported dynamically — it imports
          // this module, a static import would be a cycle).
          log.error(
            'Confirmed vault key mismatch — signing out so recovery can restore the correct key'
          )
          void import('./session-teardown')
            .then(({ teardownSession }) => teardownSession('integrity'))
            .catch((err) => log.error('Key-mismatch sign-out failed', err))
        }
      })

      queue.setOnItemEnqueued(() => engine.requestPush())

      recoverDirtyItems(runtimeSyncDb, adapters)

      pendingRuntime = {
        queue,
        network,
        ws,
        engine,
        crdtQueue,
        snapshotScheduler,
        workerBridge
      }
      runtime = pendingRuntime

      seedAbortController = new AbortController()

      await engine.start()
      log.info('Sync runtime started')

      void import('./vault-directory')
        .then(({ refreshVaultDirectory }) => refreshVaultDirectory({ force: true }))
        .catch(() => {})

      // Retry attachment uploads that failed or were interrupted in earlier
      // sessions — the durable outbox holds them across restarts.
      void import('./attachment-outbox')
        .then(({ drainAttachmentOutbox }) => drainAttachmentOutbox())
        .catch(() => {})

      trackMainEvent('sync_enabled', {
        surface: 'sync',
        action: 'enabled',
        result: 'success'
      })

      seedPromise = seedExistingCrdtDocs(crdtProvider, seedAbortController.signal).catch((err) => {
        log.warn('Post-engine CRDT seed failed (non-fatal)', err)
      })

      return engine
    } catch (error) {
      if (pendingRuntime) {
        pendingRuntime.snapshotScheduler.stop()
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
      // sync_enabled only fires on success, so a fleet-wide startup regression
      // would show up as an unexplained DROP in sync_enabled — emit the
      // failure counterpart so it spikes instead.
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'runtime_start_failed',
        result: 'failed',
        errorCode: toErrorCode(error)
      })
      return null
    } finally {
      startPromise = null
    }
  })()

  return startPromise
}

export async function stopSyncRuntime(options?: { skipFinalSync?: boolean }): Promise<void> {
  if (deferredStartTimer) {
    clearTimeout(deferredStartTimer)
    deferredStartTimer = null
  }

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

  // Cancel deferred snapshots before the shutdown flush: pushAllSnapshots()
  // covers every note with pending bytes, so a timer firing mid-teardown would
  // only duplicate that work against a provider about to be destroyed.
  active?.snapshotScheduler.stop()

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
