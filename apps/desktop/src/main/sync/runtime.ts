import { app } from 'electron'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { createCrdtSyncAdapter, createSyncAdapterRegistry } from '@memry/sync-core'
import type { RecordLocalSyncAdapter, SyncAdapter } from '@memry/sync-core'
import type { SyncItemType } from '@memry/contracts/sync-api'
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
import { handleDeviceKeyMismatch } from './device-key-mismatch'
import { resolveSyncServerUrl } from '@memry/sync-client/sync-server-url'
import { syncGoogleCalendarSource } from '../calendar/google/sync-service'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { trackMainEvent } from '../telemetry/track'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { NetworkMonitor } from './network'
import { WebSocketManager } from './websocket'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initInboxSyncService, resetInboxSyncService } from '@memry/sync-client/inbox-sync'
import { initFilterSyncService, resetFilterSyncService } from '@memry/sync-client/filter-sync'
import {
  initTaskActivitySyncService,
  resetTaskActivitySyncService
} from '@memry/sync-client/task-activity-sync'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { initBookmarkSyncService, resetBookmarkSyncService } from '@memry/sync-client/bookmark-sync'
import { initTemplateSyncService, resetTemplateSyncService } from '@memry/sync-client/template-sync'
import {
  initHomePageSyncService,
  resetHomePageSyncService
} from '@memry/sync-client/home-page-sync'
import {
  initCustomIconSyncService,
  resetCustomIconSyncService
} from '@memry/sync-client/custom-icon-sync'
import { initReminderSyncService, resetReminderSyncService } from '@memry/sync-client/reminder-sync'
import { initCanvasSyncService, resetCanvasSyncService } from '@memry/sync-client/canvas-sync'
import {
  initCanvasFolderSyncService,
  resetCanvasFolderSyncService
} from '@memry/sync-client/canvas-folder-sync'
import { initProjectSyncService, resetProjectSyncService } from '@memry/sync-client/project-sync'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { resetAttachmentDownloadSession } from '@memry/sync-client/attachment-download-state'
import { resetAttachmentQueue } from './attachment-outbox'
import { stopAttachmentDownloadRedriver } from './attachment-download-redriver'
import { initJournalSyncService, resetJournalSyncService } from './journal-sync'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import {
  initPropertyDefinitionSyncService,
  resetPropertyDefinitionSyncService
} from '@memry/sync-client/property-definition-sync'
import {
  initTagCategorySyncService,
  resetTagCategorySyncService
} from '@memry/sync-client/tag-category-sync'
import {
  initFolderConfigSyncService,
  resetFolderConfigSyncService
} from '@memry/sync-client/folder-config-sync'
import { initCalendarEventSyncService, resetCalendarEventSyncService } from './calendar-event-sync'
import {
  initCalendarSourceSyncService,
  resetCalendarSourceSyncService
} from '@memry/sync-client/calendar-source-sync'
import {
  initCalendarBindingSyncService,
  resetCalendarBindingSyncService
} from '@memry/sync-client/calendar-binding-sync'
import {
  initCalendarExternalEventSyncService,
  resetCalendarExternalEventSyncService
} from '@memry/sync-client/calendar-external-event-sync'
import { getRemoteSyncAdapter } from './item-handlers'
import type { EmitToWindows } from './item-handlers'
import { getIndexDatabase } from '../database/client'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getDeviceSigningKey } from './device-keys'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import {
  NoteBodyFlushDeferredError,
  NoteBodyOutbox,
  importLegacyPendingCrdtNotes
} from './note-body-outbox'
import { CrdtSnapshotScheduler } from '@memry/sync-client/crdt-snapshot-scheduler'
import { planCrdtUpdatePush } from '@memry/sync-client/crdt-payload'
import { recoverDirtyItems } from './dirty-recovery'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { createCrdtSnapshotBatchPush } from './crdt-snapshot-batch'
import { createCrdtSnapshotPush } from './crdt-snapshot-push'
import { postToServer, SyncServerError } from './http-client'
import { classifyError } from './sync-errors'
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
import { withRetry } from '@memry/sync-client/retry'
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
import { recordSyncStatusActivity } from './sync-activity'

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
  noteBodyOutbox: NoteBodyOutbox
  snapshotScheduler: CrdtSnapshotScheduler
  workerBridge: SyncWorkerBridge
  /**
   * Kept so teardown can detach it. The closure reaches this runtime's
   * noteBodyOutbox, and the attachment UploadQueue is a module
   * singleton that holds the NetworkMonitor past a runtime stop — leaving the
   * subscriber attached keeps the whole dead graph reachable.
   */
  onNetworkStatusChanged: (event: { online: boolean }) => void
}

function getVerifiedVaultKey(db: DataDb): Promise<Uint8Array> {
  return getOrInitializeLocalVaultKey(db, getOrCreateVaultUuid(db))
}

function emitVaultRecoveryNeeded(event: VaultRecoveryNeededEvent): void {
  broadcastToAllWindows(EVENT_CHANNELS.VAULT_RECOVERY_NEEDED, event)
}

function emitSyncStatus(event: SyncStatusChangedEvent): void {
  recordSyncStatusActivity(event)
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

function emitNoteTooLarge(noteId: string): void {
  // "A note is too large" with no name leaves the user nothing to act on, and
  // the note id is meaningless to them (#1465).
  let noteTitle: string | undefined
  try {
    noteTitle = getIndexDatabase()
      .select({ title: noteCache.title })
      .from(noteCache)
      .where(eq(noteCache.id, noteId))
      .get()?.title
  } catch (err) {
    log.debug('Could not resolve the note title for a too-large error', { noteId, error: err })
  }

  emitSyncStatus({
    status: 'error',
    pendingCount: 0,
    error: 'A note is too large to sync',
    errorCategory: 'note_too_large',
    ...(noteTitle ? { errorNoteTitle: noteTitle } : {})
  })
}

function emitLocalOnly(): void {
  emitSyncStatus({ status: 'local_only', pendingCount: 0 })
}

let runtime: SyncRuntimeState | null = null
let startPromise: Promise<SyncEngine | null> | null = null
/**
 * Liveness for the work this runtime starts and then does not await.
 *
 * Two things hang off it and neither is awaited by `stopSyncRuntime`: the
 * initial CRDT seed, and a full-state outbox flush. A flush that outlives its
 * runtime would merge into a destroyed provider, whose persistence is null —
 * so it builds a doc from markdown, applies the server's updates to it, and
 * nothing ever saves the result, against a vault this session may no longer
 * own. One signal stops both, and it is tripped before teardown touches the
 * provider.
 */
let runtimeAbortController: AbortController | null = null
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
  resetTaskActivitySyncService()
  resetBookmarkSyncService()
  resetTemplateSyncService()
  resetHomePageSyncService()
  resetCustomIconSyncService()
  resetReminderSyncService()
  resetCanvasSyncService()
  resetCanvasFolderSyncService()
  resetProjectSyncService()
  resetSettingsSyncManager()
  resetNoteSyncService()
  resetJournalSyncService()
  resetTagDefinitionSyncService()
  resetPropertyDefinitionSyncService()
  resetTagCategorySyncService()
  resetFolderConfigSyncService()
  resetCalendarEventSyncService()
  resetCalendarSourceSyncService()
  resetCalendarBindingSyncService()
  resetCalendarExternalEventSyncService()
  // Session half of the attachment download guard (in-flight claims + this
  // session's successes): per-vault, torn down on exactly the same paths. The
  // recorded FAILURES are deliberately NOT cleared — outliving this teardown is
  // the whole point, or a dead reference is re-probed on every restart.
  resetAttachmentDownloadSession()
  // The attachment UploadQueue lives in the IPC layer but captures THIS
  // runtime's NetworkMonitor, so it has to die with the runtime: a carried-over
  // queue stays subscribed to a stopped monitor (reconnect wake-up dead, its
  // `online` flag frozen) and would upload vault A's leftovers under vault B.
  // The DownloadQueue is disposed by the same registered reset.
  resetAttachmentQueue()
  // The failure re-driver only makes sense while a runtime is up to serve it.
  stopAttachmentDownloadRedriver()
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

export const getNoteBodyOutbox = (): NoteBodyOutbox | null => runtime?.noteBodyOutbox ?? null

export function getNetworkMonitor(): NetworkMonitor | null {
  return runtime?.network ?? null
}

export const getSyncWebSocket = (): WebSocketManager | null => runtime?.ws ?? null

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
      // The three branches below are policy, not failure: the services stay
      // null for the whole session on purpose, so a local mutation raised on
      // such an install is not a lost edit and must not report itself as one.
      // `markSyncIneligible` returns the same `null` these branches returned
      // before; it is what tells `local-mutations` which of the two states it
      // is looking at (#1579).
      if (!(await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN))) {
        log.debug('Sync runtime skipped: no user session')
        return markSyncIneligible()
      }

      if (store.get('sync').recoveryPhraseConfirmed === false) {
        log.debug('Sync runtime skipped: recovery phrase confirmation pending')
        return markSyncIneligible()
      }

      const { resolveEntitlementForSyncStart } = await import('../billing/paddle-billing')
      if (!(await resolveEntitlementForSyncStart()).isPaid) {
        log.info('Sync runtime skipped: not on a paid plan')
        emitLocalOnly()
        return markSyncIneligible()
      }

      // Past every policy gate: this install syncs. Everything below is a
      // failure the tripwire is meant to catch, and every window where the
      // runtime is merely between starts is one where a delete must still be
      // recorded for replay.
      markSyncEligible()

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
      // Both halves widened to the same DrizzleDb during the sync-client
      // extraction, so the old intersection is a single type now.
      type RuntimeSyncDb = SyncEngineDeps['db']
      const runtimeSyncDb = db as unknown as RuntimeSyncDb

      const getDeviceId = (): string | null => getCurrentDeviceId(db)

      // Every record sync service takes the same three dependencies. Hoisting
      // them keeps this list one line per type — adding the 22nd type otherwise
      // pushed the file past the 800-line lint ceiling.
      const recordSyncDeps = { queue, db: runtimeSyncDb, getDeviceId }

      const taskSync = initTaskSyncService(recordSyncDeps)
      const inboxSync = initInboxSyncService(recordSyncDeps)
      const filterSync = initFilterSyncService(recordSyncDeps)
      const taskActivitySync = initTaskActivitySyncService(recordSyncDeps)
      const bookmarkSync = initBookmarkSyncService(recordSyncDeps)
      const templateSync = initTemplateSyncService(recordSyncDeps)
      const homePageSync = initHomePageSyncService(recordSyncDeps)
      const customIconSync = initCustomIconSyncService(recordSyncDeps)
      const reminderSync = initReminderSyncService(recordSyncDeps)
      const canvasSync = initCanvasSyncService(recordSyncDeps)
      const canvasFolderSync = initCanvasFolderSyncService(recordSyncDeps)
      const projectSync = initProjectSyncService(recordSyncDeps)
      const settingsSync = initSettingsSyncManager(recordSyncDeps)
      const noteSync = initNoteSyncService({ queue, getDeviceId })
      const journalSync = initJournalSyncService({ queue, getDeviceId })
      const tagDefinitionSync = initTagDefinitionSyncService(recordSyncDeps)
      const tagCategorySync = initTagCategorySyncService(recordSyncDeps)
      const propertyDefinitionSync = initPropertyDefinitionSyncService(recordSyncDeps)
      const folderConfigSync = initFolderConfigSyncService(recordSyncDeps)
      const calendarEventSync = initCalendarEventSyncService(recordSyncDeps)
      const calendarSourceSync = initCalendarSourceSyncService(recordSyncDeps)
      const calendarBindingSync = initCalendarBindingSyncService(recordSyncDeps)
      const calendarExternalEventSync = initCalendarExternalEventSyncService(recordSyncDeps)

      // One line per record type: the crdt entries below still spell themselves
      // out, but the record ones are all the same shape and the file sits on the
      // 800-line lint ceiling.
      const recordAdapter = (
        type: SyncItemType,
        local: RecordLocalSyncAdapter
      ): SyncAdapter<typeof runtimeSyncDb, EmitToWindows> => ({
        type,
        kind: 'record',
        local,
        remote: getRemoteSyncAdapter(type)
      })

      const adapters = createSyncAdapterRegistry([
        recordAdapter('task', taskSync),
        recordAdapter('inbox', inboxSync),
        recordAdapter('task_activity', taskActivitySync),
        recordAdapter('filter', filterSync),
        recordAdapter('bookmark', bookmarkSync),
        recordAdapter('template', templateSync),
        recordAdapter('home_page', homePageSync),
        recordAdapter('custom_icon', customIconSync),
        recordAdapter('reminder', reminderSync),
        recordAdapter('project', projectSync),
        recordAdapter('settings', settingsSync),
        {
          type: 'note',
          kind: 'crdt',
          local: noteSync,
          remote: getRemoteSyncAdapter('note'),
          crdt: createCrdtSyncAdapter('note', { documentContentOnly: true })
        },
        recordAdapter('journal', journalSync),
        recordAdapter('tag_definition', tagDefinitionSync),
        recordAdapter('tag_category', tagCategorySync),
        recordAdapter('property_definition', propertyDefinitionSync),
        recordAdapter('folder_config', folderConfigSync),
        recordAdapter('calendar_event', calendarEventSync),
        recordAdapter('calendar_source', calendarSourceSync),
        recordAdapter('calendar_binding', calendarBindingSync),
        recordAdapter('calendar_external_event', calendarExternalEventSync),
        recordAdapter('canvas', canvasSync),
        {
          type: 'canvas_folder',
          kind: 'record',
          local: canvasFolderSync,
          remote: getRemoteSyncAdapter('canvas_folder')
        }
      ])

      const snapshotScheduler = new CrdtSnapshotScheduler((noteId) =>
        crdtProvider.pushSnapshotForNote(noteId)
      )
      // Durable CRDT body outbox (#2298): note_body rows in sync_queue, pushed
      // through this fn, which keeps the CRDT route's own 429 gate and window.
      const pushNoteBody = async (noteId: string, updates: Uint8Array[]): Promise<void> => {
        let token = await getValidAccessToken()
        const vaultKey = await getOptionalRuntimeVaultKey(db, 'crdt update batch')
        const signingSecretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
        if (!token || !vaultKey || !signingSecretKey) {
          if (vaultKey) secureCleanup(vaultKey)
          if (signingSecretKey) secureCleanup(signingSecretKey)
          // Throwing keeps the rows queued; returning would ack them. The
          // condition is transient: ~14 minutes into an outage the access
          // token cannot be refreshed and getValidAccessToken returns null.
          throw new Error('Missing credentials for CRDT update push')
        }

        try {
          const b64Updates = updates.map((raw) => {
            const encrypted = encryptCrdtUpdate(raw, vaultKey, noteId, signingSecretKey)
            return Buffer.from(encrypted).toString('base64')
          })

          const { requests, oversized } = planCrdtUpdatePush(b64Updates)

          for (const batch of requests) {
            await withRetry(
              () =>
                withAuthRetry(
                  (authToken) =>
                    postToServer('/sync/crdt/updates', { noteId, updates: batch }, authToken),
                  token!,
                  crdtAuthRetryDeps,
                  (fresh) => {
                    token = fresh
                  }
                ),
              { maxRetries: 3, baseDelayMs: 2000 }
            )
          }

          if (oversized.length > 0) {
            // One update this large cannot ride the incremental path at all: the
            // server stores each update as a D1 blob. The operations are already
            // in the local doc, so push the whole document to the R2-backed
            // snapshot endpoint — an existing payload shape every client version
            // pulls — instead of dropping the user's edit.
            log.warn('CRDT update too large for the incremental path, pushing a snapshot instead', {
              noteId,
              oversizedCount: oversized.length,
              largestChars: Math.max(...oversized.map((update) => update.length))
            })
            const pushed = await crdtProvider.pushSnapshotForNote(noteId)
            if (!pushed) {
              // Throwing keeps the rows queued, so the next flush retries the
              // snapshot. Returning here would ack them, the silent drop this
              // path exists to remove; snapshotPushFn already surfaced it.
              log.error('CRDT snapshot fallback for an oversized update failed', { noteId })
              throw new NoteBodyFlushDeferredError('CRDT snapshot fallback failed')
            }
            // The snapshot is itself the compaction point, so no scheduled one.
            return
          }

          // The incremental batch is already durable on the server; the full
          // snapshot is only a compaction point, so it rides a long debounce
          // instead of re-encoding the whole document every flush.
          snapshotScheduler.request(noteId)
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            // withAuthRetry already attempted a refresh. Pause so the queued
            // rows wait for the next successful refresh (setOnTokenRefreshed
            // resumes the outbox); token-manager owns the session-expired
            // toast for terminal refresh failures.
            noteBodyOutbox.pause()
          }
          if (err instanceof SyncServerError && err.statusCode === 413) {
            if (classifyError(err).category === 'storage_quota_exceeded') {
              noteBodyOutbox.pause()
              emitQuotaExceeded()
            } else {
              // Body-limit 413: one oversized note must not stall the queue
              // for every other note.
              emitNoteTooLarge(noteId)
            }
          }
          throw err
        } finally {
          secureCleanup(vaultKey)
          secureCleanup(signingSecretKey)
        }
      }
      const noteBodyOutbox = new NoteBodyOutbox({ queue, push: pushNoteBody })

      // `engine` is referenced lazily: nothing invokes these fns between
      // `crdtProvider.init` below and the `const engine` assignment.
      const snapshotPushFn = createCrdtSnapshotPush({
        getAccessToken: () => getValidAccessToken(),
        getVaultKey: () => getOptionalRuntimeVaultKey(db, 'crdt snapshot push'),
        getSigningKey: () => retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY),
        authRetryDeps: crdtAuthRetryDeps,
        hasUnmergedRemoteState: (noteId) => engine.hasUnmergedRemoteCrdtState(noteId),
        onNotCovered: (noteId, refusal) => engine.recordSnapshotRefusal(noteId, refusal),
        onPushed: (noteId, pushed) => getCrdtProvider().recordPushedSnapshot(noteId, pushed),
        onError: (noteId, err) => {
          if (err instanceof SyncServerError && err.statusCode === 401) {
            // withAuthRetry already attempted a refresh — see the update-batch
            // handler above. The caller keeps pendingSnapshotBytes, so the
            // snapshot re-pushes after the outbox resumes.
            noteBodyOutbox.pause()
          }
          if (err instanceof SyncServerError && err.statusCode === 413) {
            if (classifyError(err).category === 'storage_quota_exceeded') {
              noteBodyOutbox.pause()
              emitQuotaExceeded()
            } else {
              // Body-limit 413: one oversized note must not stall the queue
              // for every other note.
              emitNoteTooLarge(noteId)
            }
          }
        }
      })

      // One request for up to MAX_CRDT_SNAPSHOT_BATCH_ENTRIES notes instead of
      // one per note. It reuses `snapshotPushFn` for everything the batch is
      // not allowed to carry — a note whose server state this device has not
      // merged, and every note on a server too old to have the endpoint — so
      // the destructive-endpoint reasoning above still has exactly one owner.
      const snapshotBatchPushFn = createCrdtSnapshotBatchPush({
        pushSingle: snapshotPushFn,
        hasUnmergedRemoteState: (noteId) => engine.hasUnmergedRemoteCrdtState(noteId),
        getAccessToken: () => getValidAccessToken(),
        getVaultKey: () => getOptionalRuntimeVaultKey(db, 'crdt snapshot batch push'),
        getSigningKey: () => retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY),
        authRetryDeps: crdtAuthRetryDeps,
        onPushed: (noteId, pushed) => getCrdtProvider().recordPushedSnapshot(noteId, pushed),
        onNotCovered: (noteId, refusal) => engine.recordSnapshotRefusal(noteId, refusal),
        onBatchError: (err) => {
          // Same two conditions the single push handles, and for the same
          // reasons — see the comments in snapshotPushFn. A body-limit 413
          // never reaches here: the batch falls back to the per-note path so
          // the note that is actually too large can be named.
          if (err instanceof SyncServerError && err.statusCode === 401) {
            noteBodyOutbox.pause()
          }
          if (
            err instanceof SyncServerError &&
            err.statusCode === 413 &&
            classifyError(err).category === 'storage_quota_exceeded'
          ) {
            noteBodyOutbox.pause()
            emitQuotaExceeded()
          }
        }
      })

      const crdtProvider = getCrdtProvider()
      await crdtProvider.init(noteBodyOutbox, snapshotPushFn, snapshotBatchPushFn)
      // Once, then the pre-#2298 file is gone: its notes become full-state rows.
      importLegacyPendingCrdtNotes(queue, app.getPath('userData'))

      // Created before anything can flush a full-state row. Held in a local as
      // well as the module slot, and the closure below reads the LOCAL:
      // `stopSyncRuntime` nulls the slot up front and a new session may fill
      // it, while this runtime's flush can still be in flight.
      const runtimeAbort = (runtimeAbortController = new AbortController())

      const emitFn = (channel: string, data: unknown): void => {
        if (channel === EVENT_CHANNELS.STATUS_CHANGED) recordSyncStatusActivity(data)
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
        noteBodyOutbox.pause()
      }
      noteBodyOutbox.start()
      const onNetworkStatusChanged = ({ online }: { online: boolean }): void => {
        if (online) {
          noteBodyOutbox.resume()
          // Reconnect is the moment transiently-failed attachment downloads
          // become worth retrying; the re-driver is re-entrant-safe and gated
          // by each row's own backoff window.
          void import('./attachment-download-redriver')
            .then(({ redriveAttachmentDownloads }) => redriveAttachmentDownloads())
            .catch(() => {})
        } else {
          noteBodyOutbox.pause()
        }
      }
      network.on('status-changed', onNetworkStatusChanged)
      const ws = new WebSocketManager({
        getAccessToken: () => getValidAccessToken(),
        getAppVersion: () => app.getVersion(),
        isOnline: () => network.online,
        serverUrl: resolveSyncServerUrl()
      })

      setOnTokenRefreshed(() => {
        if (network.online) {
          noteBodyOutbox.resume()
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
              // The local row is written from the keypair the device was
              // REGISTERED with, so a mismatch means the keychain key changed
              // afterwards — the server still holds the old public key under
              // this device id. Rewriting the row here only made the local
              // state agree with a key the server rejects: every push earned
              // SYNC_INVALID_SIGNATURE and every manifest this device signed
              // was unverifiable, forever (#2218). Only re-registration mints
              // a device id that matches the key, so escalate instead.
              log.error('Signing key does not match the registered device key', { deviceId })
              secureCleanup(secretKey)
              handleDeviceKeyMismatch()
              return null
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
          void syncGoogleCalendarSource(db, sourceId).catch((err) => {
            log.warn('calendarSyncOneSource failed', { sourceId, err })
          })
        },
        checkAccountKey: () => checkLocalKeyAgainstAccount(),
        onDeviceKeyMismatch: () => handleDeviceKeyMismatch(),
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
      crdtProvider.setSnapshotCoverage((noteId, heldRevision) =>
        engine.snapshotCoverage(noteId, heldRevision)
      )
      crdtProvider.setOweRemoteMerge((noteId) => engine.oweCrdtPull(noteId))
      // A full-state row queued with no runtime (a note leaving local-only) may
      // owe bodies the feed skipped: flagged, it claims nothing until its own
      // flush pull merged, which clears the flag. No second pull is owed.
      for (const noteId of queue.listFullStateNoteBodyNoteIds()) {
        if (!crdtProvider.isNoteLocalOnly(noteId)) engine.markCrdtRemoteStateUnmerged(noteId)
      }

      recoverDirtyItems(runtimeSyncDb, adapters)

      pendingRuntime = {
        queue,
        network,
        ws,
        engine,
        noteBodyOutbox,
        snapshotScheduler,
        workerBridge,
        onNetworkStatusChanged
      }
      runtime = pendingRuntime

      await engine.start()
      log.info('Sync runtime started')

      void import('./vault-directory')
        .then(({ refreshVaultDirectory }) => refreshVaultDirectory({ force: true }))
        .catch(() => {})

      // Folders made before folder creation wrote a folder_config row have no
      // row at all, so an empty one never reached another device. Same shape as
      // the attachment backfill below: fix forward, then close the gap once for
      // what already exists. Lazy import keeps the vault module off the sync
      // start path when the pass is a no-op.
      void import('../notes/folder-config-effects')
        .then(({ backfillFolderConfigs }) => backfillFolderConfigs())
        .catch((error: unknown) => log.warn('Folder config backfill skipped', { error }))

      // Retry attachment uploads that failed or were interrupted in earlier
      // sessions — the durable outbox holds them across restarts. The backfill
      // runs first and in the same chain: it puts rows in that outbox for files
      // whose save-time emit never fired, and those rows are only picked up by
      // the drain that follows them.
      void (async () => {
        await import('./attachment-backfill')
          .then(({ backfillUnsyncedAttachments }) => backfillUnsyncedAttachments())
          // A backfill that cannot run must never keep the drain from retrying
          // the rows already pending — those are the older problem.
          .catch((error: unknown) => log.warn('Attachment backfill skipped', { error }))
        const { drainAttachmentOutbox } = await import('./attachment-outbox')
        await drainAttachmentOutbox()
        // Download side of the same promise: failed attachment downloads are
        // persisted in attachment_download_failures, and this is what retries
        // them without waiting for the note to be re-applied from a pull. The
        // interval keeps re-driving while the runtime stays up.
        const { redriveAttachmentDownloads, startAttachmentDownloadRedriver } =
          await import('./attachment-download-redriver')
        startAttachmentDownloadRedriver()
        await redriveAttachmentDownloads()
      })().catch(() => {})

      // Full-state rows (signed-out edits, a note leaving local-only, the
      // imported pre-#2298 list) are the notes most likely to have diverged
      // from a peer, so each is merged with the server's state immediately
      // before its push, as the retired replay did, and only after the first
      // full sync above; a merge that does not complete keeps the row. The
      // state goes to `/sync/crdt/updates`, which prunes nothing; only an
      // oversized one falls back to a snapshot. The abort check stops a flush
      // that outlives this runtime from merging into a destroyed provider
      // (#1514).
      noteBodyOutbox.enableFullStateFlush(async (noteId) => {
        if (runtimeAbort.signal.aborted) throw new Error('Sync runtime stopped')
        if (!crdtProvider.isNoteSyncable(noteId)) {
          engine.clearCrdtUnmergedForDroppedNote(noteId)
          return null
        }
        if (!(await engine.mergeRemoteCrdtForNote(noteId))) {
          throw new Error('Server CRDT state did not merge')
        }
        if (runtimeAbort.signal.aborted) throw new Error('Sync runtime stopped')
        return crdtProvider.readSyncableState(noteId)
      })

      trackMainEvent('sync_enabled', {
        surface: 'sync',
        action: 'enabled',
        result: 'success'
      })

      seedPromise = seedExistingCrdtDocs(crdtProvider, runtimeAbort.signal).catch((err) => {
        log.warn('Post-engine CRDT seed failed (non-fatal)', err)
      })

      return engine
    } catch (error) {
      if (pendingRuntime) {
        pendingRuntime.snapshotScheduler.stop()
        pendingRuntime.noteBodyOutbox.stop()
        pendingRuntime.ws.disconnect()
        pendingRuntime.network.removeListener(
          'status-changed',
          pendingRuntime.onNetworkStatusChanged
        )
        pendingRuntime.network.stop()
        await pendingRuntime.workerBridge.stop().catch(() => {})
        await pendingRuntime.engine.stop().catch(() => {})
      }
      // Same reason as the teardown path: this branch destroys the provider, and
      // a full-state outbox flush may be in flight. It must not merge into it.
      runtimeAbortController?.abort()
      runtimeAbortController = null
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
    // Prompt cancel BEFORE awaiting the start: startPromise includes the
    // engine's entire first fullSync, so a close or vault switch seconds into a
    // fresh-vault pull used to stall this IPC for the whole minutes-long pull.
    // The engine is reachable mid-start — `runtime` is assigned before
    // `engine.start()` is awaited — and requestCancel aborts its active cycle
    // and latches off every later one, so the await below only covers safe
    // teardown of work already unwinding. With no runtime yet there is no sync
    // cycle to cancel; the start is still inside policy gates or provider init
    // and settles on its own.
    runtime?.engine.requestCancel()
    await startPromise.catch(() => {})
  }

  // After the in-flight start is awaited, so this is the controller belonging to
  // the runtime being stopped — and before everything else, in particular before
  // the provider is destroyed below. The seed and a full-state outbox flush
  // both run unawaited, and the flush's `mergeRemoteCrdtForNote` is the call
  // that would open a note on a provider with no persistence left.
  runtimeAbortController?.abort()
  runtimeAbortController = null
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
  // token-manager holds this runtime's callback in a single slot and keeps
  // firing it long after teardown (its refresh timer is independent), so the
  // closure pins the dead noteBodyOutbox/ws/network graph and resumes a stopped
  // queue on the next refresh. Detach in the same tick that clears `runtime`:
  // that is the last moment before a concurrent startSyncRuntime() can get past
  // its `if (runtime) return` guard and install its own callback — clearing
  // after any of the awaits below would silently unhook the *live* runtime.
  setOnTokenRefreshed(null)

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

  active.noteBodyOutbox.stop()
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
  active.network.removeListener('status-changed', active.onNetworkStatusChanged)
  active.network.stop()
  log.info('Sync runtime stopped')
}
