import {
  RecordChangesResponseSchema,
  RecordPullResponseSchema,
  DeviceKeysResponseSchema,
  SyncStatusSchema,
  type RecordChangesResponse,
  type SyncStatusInput
} from '@memry/contracts/sync-api'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { SyncHttpClient } from '../adapters/http-client.ts'
import type { SyncLogger } from '../adapters/logger.ts'
import { SyncServerError } from '../http-errors.ts'
import { withRetry } from '../retry.ts'
import type { SyncCryptoProvider } from './crypto-provider.ts'
import { decryptRecordItem, SignatureVerificationError } from './record-decrypt.ts'
import { seamJsonRequest, type SeamHttpContext } from './http.ts'
import type { DecodedRecordItem, PullStore, RecordItemRef } from './store.ts'

/**
 * Pull-only record sync engine on top of the ten seams — the mobile side of
 * the T045 owner decision (option b): a clean engine in the package rather
 * than a 60-file desktop refactor. Pull SEMANTICS mirror desktop's
 * `PullCoordinator` exactly so the two engines cannot drift:
 *
 * - one global record cursor, a decimal string of the server's `server_cursor`,
 *   advanced to `nextCursor` only AFTER the page's items were applied;
 * - `deleted` ids are unioned into the page's `/sync/pull` request — tombstones
 *   arrive as full signed items and a set `deletedAt` IS the delete signal;
 * - a whole-page schema-parse failure advances the cursor and drops the page
 *   (the failure type negotiation exists to prevent), logged loudly;
 * - a page where EVERY item fails decryption stops the run (desktop's
 *   'breaker': server-side poisoned payloads) — the cursor still advances past
 *   the page and every item is recorded corrupt, but the run reports refused
 *   so callers do not write success state;
 * - item-level failures are recorded via `markItemCorrupt`, never silently
 *   dropped; the rest of the page still applies, FK parents first.
 */

// Mirrors desktop pull-coordinator.ts PULL_APPLY_ORDER.
const PULL_APPLY_ORDER: Record<string, number> = {
  project: 0,
  folder_config: 0,
  tag_definition: 0,
  filter: 0,
  settings: 0,
  calendar_source: 0,
  agent_conversation: 0,
  task: 2,
  agent_message: 2,
  calendar_event: 2,
  calendar_external_event: 2,
  calendar_binding: 3
}

const applyRank = (type: string): number => PULL_APPLY_ORDER[type] ?? 1

export const sortByApplyOrder = <T extends { type: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => applyRank(a.type) - applyRank(b.type))

const PULL_PAGE_LIMIT = 100
const PULL_BATCH_MAX_IDS = 100

export interface PullEngineDeps {
  http: SyncHttpClient
  crypto: SyncCryptoProvider
  store: PullStore
  vaultId: string
  clientHeaderValue: string
  getAccessToken: () => string
  /** Resolves the new token, or null when the session is gone. */
  refreshAccessToken?: () => Promise<string | null>
  getVaultKey: () => Uint8Array | null
  log: SyncLogger
  isOnline?: () => boolean
  signal?: AbortSignal
}

export interface PullRunResult {
  ok: boolean
  refused: 'none' | 'no-credentials' | 'breaker' | 'aborted'
  pagesApplied: number
  itemsApplied: number
  itemsCorrupt: number
  /** Note/journal ids whose bodies may have moved — feed to the CRDT body pull. */
  changedNoteIds: string[]
}

interface FetchedPage {
  changes: RecordChangesResponse
}

export class RecordPullEngine {
  private deviceKeys = new Map<string, Uint8Array | null>()
  private deviceKeysFetched = false
  private accessToken: string

  constructor(private readonly deps: PullEngineDeps) {
    this.accessToken = deps.getAccessToken()
  }

  private httpCtx(): SeamHttpContext {
    return {
      http: this.deps.http,
      accessToken: () => this.accessToken,
      vaultId: this.deps.vaultId,
      clientHeaderValue: this.deps.clientHeaderValue,
      signal: this.deps.signal
    }
  }

  /** One request with the desktop 401 rule: refresh once, retry once. */
  private async requestWithAuthRetry<T>(req: {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
  }): Promise<T> {
    try {
      return await seamJsonRequest<T>(this.httpCtx(), req)
    } catch (err) {
      const is401 = err instanceof SyncServerError && err.statusCode === 401
      if (!is401 || !this.deps.refreshAccessToken) throw err
      const fresh = await this.deps.refreshAccessToken()
      if (!fresh) throw err
      this.accessToken = fresh
      return seamJsonRequest<T>(this.httpCtx(), req)
    }
  }

  private retryOpts() {
    return {
      signal: this.deps.signal,
      isOnline: this.deps.isOnline
    }
  }

  private async resolveDeviceKey(signerDeviceId: string): Promise<Uint8Array | null> {
    if (!this.deviceKeysFetched) {
      const raw = await withRetry(
        () => this.requestWithAuthRetry<unknown>({ method: 'GET', path: '/auth/devices' }),
        this.retryOpts()
      ).then((r) => r.value)
      const parsed = DeviceKeysResponseSchema.safeParse(raw)
      if (parsed.success) {
        for (const device of parsed.data.devices) {
          this.deviceKeys.set(device.id, this.deps.crypto.fromBase64(device.signingPublicKey))
        }
      } else {
        this.deps.log.warn('Device keys response failed validation', {
          issues: parsed.error.issues.length
        })
      }
      this.deviceKeysFetched = true
    }
    return this.deviceKeys.get(signerDeviceId) ?? null
  }

  private async fetchChangesPage(cursor: string | null): Promise<RecordChangesResponse> {
    const query = cursor
      ? `?cursor=${encodeURIComponent(cursor)}&limit=${PULL_PAGE_LIMIT}`
      : `?limit=${PULL_PAGE_LIMIT}`
    const raw = await withRetry(
      () => this.requestWithAuthRetry<unknown>({ method: 'GET', path: `/sync/changes${query}` }),
      this.retryOpts()
    ).then((r) => r.value)
    const parsed = RecordChangesResponseSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Invalid /sync/changes response: ${parsed.error.issues[0]?.message}`)
    }
    return parsed.data
  }

  /**
   * Pull one page's blobs, decrypt, verify, decode. Returns null when the
   * whole /sync/pull response failed schema validation — the caller drops the
   * page (cursor still advances; desktop pull_page_dropped semantics).
   */
  private async pullAndDecode(
    itemIds: string[],
    vaultKey: Uint8Array,
    counters: { corrupt: number }
  ): Promise<DecodedRecordItem[] | null> {
    const decoded: DecodedRecordItem[] = []

    for (let i = 0; i < itemIds.length; i += PULL_BATCH_MAX_IDS) {
      const chunk = itemIds.slice(i, i + PULL_BATCH_MAX_IDS)
      const raw = await withRetry(
        () =>
          this.requestWithAuthRetry<unknown>({
            method: 'POST',
            path: '/sync/pull',
            body: { itemIds: chunk }
          }),
        this.retryOpts()
      ).then((r) => r.value)

      const parsed = RecordPullResponseSchema.safeParse(raw)
      if (!parsed.success) {
        this.deps.log.error('Pull page failed schema validation; page dropped', {
          itemCount: chunk.length,
          issue: parsed.error.issues[0]?.message
        })
        return null
      }

      for (const item of parsed.data.items) {
        const itemOp = item.deletedAt !== undefined ? 'delete' : item.operation
        if (itemOp === 'delete') {
          // Tombstone bodies are never decoded (desktop apply-item.ts rule).
          decoded.push({
            id: item.id,
            type: item.type,
            operation: 'delete',
            deletedAt: item.deletedAt ?? 0,
            clock: item.clock
          })
          continue
        }

        const signerKey = await this.resolveDeviceKey(item.signerDeviceId)
        if (!signerKey) {
          counters.corrupt++
          await this.deps.store.markItemCorrupt(
            item.id,
            `unresolvable signer ${item.signerDeviceId}`
          )
          this.deps.log.warn('Skipping item from unresolvable signer', {
            itemId: item.id,
            signerDeviceId: item.signerDeviceId
          })
          continue
        }

        try {
          const content = await decryptRecordItem(
            this.deps.crypto,
            {
              id: item.id,
              type: item.type,
              operation: item.operation,
              cryptoVersion: item.cryptoVersion ?? 1,
              encryptedKey: item.blob.encryptedKey,
              keyNonce: item.blob.keyNonce,
              encryptedData: item.blob.encryptedData,
              dataNonce: item.blob.dataNonce,
              signature: item.signature,
              signerDeviceId: item.signerDeviceId,
              deletedAt: item.deletedAt,
              clock: item.clock
            },
            vaultKey,
            signerKey
          )
          decoded.push({
            id: item.id,
            type: item.type,
            operation: item.operation,
            clock: item.clock,
            payloadJson: new TextDecoder().decode(content)
          })
        } catch (err) {
          counters.corrupt++
          const reason =
            err instanceof SignatureVerificationError
              ? 'signature verification failed'
              : `decrypt failed: ${err instanceof Error ? err.message : String(err)}`
          await this.deps.store.markItemCorrupt(item.id, reason)
          this.deps.log.warn('Item failed decrypt/verify; recorded corrupt', {
            itemId: item.id,
            type: item.type,
            reason
          })
        }
      }
    }

    return decoded
  }

  private collectChangedNoteIds(items: DecodedRecordItem[], into: Set<string>): void {
    for (const item of items) {
      if (item.operation === 'delete') continue
      if (item.type !== 'note' && item.type !== 'journal') continue
      try {
        const payload = item.payloadJson
          ? (JSON.parse(item.payloadJson) as { fileType?: string })
          : {}
        // Binary notes (imported PDFs etc.) have no CRDT body — same
        // classification desktop's pull uses when queueing crdtNoteIds.
        if (!payload.fileType || !isBinaryFileType(payload.fileType)) into.add(item.id)
      } catch {
        into.add(item.id)
      }
    }
  }

  /**
   * Desktop-equivalent incremental pull: changes → pull → decrypt → apply →
   * advance cursor, page by page until `hasMore` is false.
   */
  async pullIncremental(): Promise<PullRunResult> {
    const result: PullRunResult = {
      ok: false,
      refused: 'none',
      pagesApplied: 0,
      itemsApplied: 0,
      itemsCorrupt: 0,
      changedNoteIds: []
    }
    const vaultKey = this.deps.getVaultKey()
    if (!vaultKey) {
      result.refused = 'no-credentials'
      return result
    }

    const changedNotes = new Set<string>()
    const counters = { corrupt: 0 }
    let cursor = await this.deps.store.getRecordCursor()
    let hasMore = true

    while (hasMore) {
      if (this.deps.signal?.aborted) {
        result.refused = 'aborted'
        break
      }

      const changes = await this.fetchChangesPage(cursor)
      const itemIds = [...changes.items.map((i) => i.id), ...changes.deleted]

      if (itemIds.length > 0) {
        const corruptBefore = counters.corrupt
        const decoded = await this.pullAndDecode(itemIds, vaultKey, counters)

        if (decoded === null) {
          // Whole-page validation failure: drop the page, advance the cursor.
          await this.deps.store.setRecordCursor(String(changes.nextCursor))
          cursor = String(changes.nextCursor)
          hasMore = changes.hasMore
          continue
        }

        const pageAllFailed =
          decoded.length === 0 && counters.corrupt > corruptBefore && itemIds.length > 0
        if (pageAllFailed) {
          // Breaker: a full page of undecryptable payloads. Advance past it so
          // retries cannot loop forever, but refuse the run so no success
          // state is written (desktop 2026-07 incident semantics).
          await this.deps.store.setRecordCursor(String(changes.nextCursor))
          result.refused = 'breaker'
          break
        }

        const sorted = sortByApplyOrder(decoded)
        await this.deps.store.applyRecordItems(sorted)
        this.collectChangedNoteIds(sorted, changedNotes)
        result.itemsApplied += sorted.length
      }

      await this.deps.store.setRecordCursor(String(changes.nextCursor))
      cursor = String(changes.nextCursor)
      result.pagesApplied++
      hasMore = changes.hasMore
    }

    result.itemsCorrupt = counters.corrupt
    result.changedNoteIds = [...changedNotes]
    result.ok = result.refused === 'none'
    return result
  }

  /**
   * Windowed first-sync phase A: walk the whole change feed storing REFS only
   * (payload_state: metadata-only), advancing the cursor page by page. Safe
   * because refs are durably recorded before the cursor moves — blobs are
   * fetched by id afterwards, so a crash resumes without loss.
   */
  async pullRefsToEnd(): Promise<{ refs: number }> {
    let cursor = await this.deps.store.getRecordCursor()
    let hasMore = true
    let total = 0

    while (hasMore) {
      if (this.deps.signal?.aborted) break
      const changes = await this.fetchChangesPage(cursor)
      const deletedSet = new Set(changes.deleted)
      const refs: RecordItemRef[] = changes.items.map((i) => ({
        id: i.id,
        type: i.type,
        modifiedAt: i.modifiedAt,
        size: i.size,
        deleted: deletedSet.has(i.id)
      }))
      // Ids in `deleted` with no ref row have no type on the wire; the store
      // marks any existing row deleted and otherwise records a bare tombstone.
      const bareDeletes = changes.deleted.filter((id) => !changes.items.some((i) => i.id === id))
      await this.deps.store.applyRecordRefs(refs, bareDeletes)
      total += refs.length + bareDeletes.length
      await this.deps.store.setRecordCursor(String(changes.nextCursor))
      cursor = String(changes.nextCursor)
      hasMore = changes.hasMore
    }

    return { refs: total }
  }

  /**
   * Windowed first-sync phase B / on-demand fetch: pull blobs for specific ids
   * (any order, chunked at the protocol's 100-id cap). Does not move the
   * cursor.
   */
  async pullBlobsByIds(
    itemIds: string[]
  ): Promise<{ applied: number; corrupt: number; changedNoteIds: string[] }> {
    const vaultKey = this.deps.getVaultKey()
    if (!vaultKey || itemIds.length === 0) return { applied: 0, corrupt: 0, changedNoteIds: [] }

    const counters = { corrupt: 0 }
    const changedNotes = new Set<string>()
    let applied = 0

    const decoded = await this.pullAndDecode(itemIds, vaultKey, counters)
    if (decoded !== null && decoded.length > 0) {
      const sorted = sortByApplyOrder(decoded)
      await this.deps.store.applyRecordItems(sorted)
      this.collectChangedNoteIds(sorted, changedNotes)
      applied = sorted.length
    }

    return { applied, corrupt: counters.corrupt, changedNoteIds: [...changedNotes] }
  }

  /**
   * `GET /sync/status` with the client header attached, so the response
   * carries `clientPolicy` — how a pull-only client learns about a flipped
   * kill switch or a raised version floor without attempting a write (T051).
   */
  async fetchStatus(): Promise<SyncStatusInput | null> {
    const raw = await withRetry(
      () => this.requestWithAuthRetry<unknown>({ method: 'GET', path: '/sync/status' }),
      { ...this.retryOpts(), maxRetries: 2 }
    ).then((r) => r.value)
    const parsed = SyncStatusSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }
}
