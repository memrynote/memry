import path from 'path'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import { moveStoreDir } from './crdt-store-move'
import { setAsideAmbiguousLegacyDocs } from './crdt-legacy-partition'
import {
  clearLegacyCrdtStorePartitionPending,
  clearPendingCrdtStoreRename,
  getLegacyCrdtStoreClaim,
  getLegacyCrdtStorePartitionPending,
  getPendingCrdtStoreRename,
  getVaults,
  recordLegacyCrdtStoreClaim
} from '../store'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'

// Same scope as crdt-provider on purpose: production log triage greps for
// 'CrdtProvider' when it is looking at the CRDT store.
const log = createLogger('CrdtProvider')

/** The one store every build before per-vault scoping wrote to, for all vaults. */
const LEGACY_STORE_DIRNAME = 'crdt-store'
/** Parent directory holding one store per vault. */
const STORE_ROOT_DIRNAME = 'crdt-stores'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface VaultCrdtStore {
  vaultUuid: string
  storagePath: string
}

export function legacyCrdtStorePath(): string {
  return path.join(app.getPath('userData'), LEGACY_STORE_DIRNAME)
}

/**
 * Filesystem-safe directory name for a vault uuid.
 *
 * The uuid is minted by `randomUUID()` locally, but a linked device adopts the
 * *server's* value, so this must not assume the shape. A canonical uuid is used
 * verbatim (readable in logs and support sessions); anything else is hashed, so
 * a separator, a path traversal or a case-only difference can never resolve to
 * another vault's directory. Lower-cased first because macOS and Windows
 * filesystems are case-insensitive: two casings of one uuid must be one store.
 */
function storeDirName(vaultUuid: string): string {
  const normalized = vaultUuid.trim().toLowerCase()
  if (UUID_PATTERN.test(normalized)) return normalized
  return createHash('sha256').update(vaultUuid).digest('hex').slice(0, 32)
}

/** Where the store for `vaultUuid` lives, whether or not any vault holds it now. */
export function vaultCrdtStorePath(vaultUuid: string): string {
  return path.join(app.getPath('userData'), STORE_ROOT_DIRNAME, storeDirName(vaultUuid))
}

/**
 * Where the currently open vault's CRDT store lives, or null when there is no
 * vault to scope it to.
 *
 * Null is the normal answer during startup: main initializes the provider
 * before `autoOpenLastVault()`, and on the vault picker there is no vault at
 * all. The caller must treat it as "not yet", never as a failure.
 */
export function resolveVaultCrdtStore(): VaultCrdtStore | null {
  if (!isDatabaseInitialized()) return null

  try {
    const vaultUuid = getOrCreateVaultUuid(getDatabase())
    if (!vaultUuid) return null
    return { vaultUuid, storagePath: vaultCrdtStorePath(vaultUuid) }
  } catch (err) {
    log.error('Could not resolve the vault CRDT store path', { error: err })
    return null
  }
}

/**
 * Could the legacy store hold a document that is not this vault's?
 *
 * Only if this install has ever opened more than one vault — that list is the
 * only record of the fact, because the store itself has no vault dimension to
 * read. Both ways of being wrong fail safe: an install that lost a vault from
 * the list reads as single-vault and keeps today's behaviour, and a duplicate
 * entry for a moved vault reads as multi-vault and only costs the deterministic
 * ids their history, which markdown re-seeds.
 */
function legacyStoreCouldBeAnotherVaults(): boolean {
  return getVaults().length > 1
}

/**
 * Hand the legacy global store to the first vault that opens after the upgrade,
 * and to no other.
 *
 * That store is keyed by note id with no vault dimension, so its contents are
 * only meaningfully "the history of" one vault — and note ids are not even
 * unique across vaults (journal notes use deterministic date-based ids such as
 * `j2026-08-13`). Giving it to every vault as a read fallback would recreate
 * the cross-vault bleed that the sign-out wipe used to contain by destroying
 * everything. So: one claimant, recorded durably, and every other vault starts
 * empty and re-seeds from its own markdown — the normal path for a note with no
 * stored history.
 *
 * One claimant is not enough on its own, though. On an install that has opened
 * more than one vault, the claimant inherits entries for ids it does not own.
 * Random note ids are inert — nothing ever asks for them. Deterministic ones
 * are not: the store's `j2026-08-13` is every vault's journal for that day
 * merged into one document, and a vault that loads it gets another vault's
 * text, silently, because a document that already has content is never seeded
 * from markdown. So the claim also records that those documents still have to
 * be set aside (see `partitionInheritedLegacyStore`), and the pass runs before
 * the provider opens the store.
 *
 * The claim, and the partition it owes, are one file write made before the
 * move — which is what makes the whole thing crash-safe:
 *
 *  - crash after the claim, before the move → the legacy directory is still
 *    there and still claimed by this vault, so the next launch of the *same*
 *    vault finishes the move and no other vault may touch it;
 *  - crash after the move, before or during the partition → the pending record
 *    still names this vault, and it is what drives the pass, not the legacy
 *    directory that no longer exists. So the next launch partitions the store
 *    it now owns;
 *  - crash after both → the pending record is gone and the claim is settled,
 *    so there is nothing to double-apply.
 *
 * Nothing here bypasses the store's own integrity handling: the move is a plain
 * directory rename, and `openCrdtPersistence` still runs its preflight,
 * quarantine and probe against the inherited store afterwards.
 */
export async function inheritLegacyCrdtStore({
  vaultUuid,
  storagePath
}: VaultCrdtStore): Promise<void> {
  const claimedBy = getLegacyCrdtStoreClaim()
  if (claimedBy !== undefined && claimedBy !== vaultUuid) return

  const legacyPath = legacyCrdtStorePath()
  if (!existsSync(legacyPath)) return

  if (existsSync(storagePath)) {
    // Only reachable when a previous move fell back to copy+delete and the
    // delete failed: this vault already holds the history. Merging the leftover
    // in would replay a second copy of every update, so leave it where it is —
    // it is redundant bytes, not data anyone is missing.
    log.warn('Legacy CRDT store left in place: this vault already has a store', {
      legacyPath,
      storagePath
    })
    return
  }

  if (claimedBy === undefined) {
    recordLegacyCrdtStoreClaim(vaultUuid, { partitionPending: legacyStoreCouldBeAnotherVaults() })
  }

  if (await moveStoreDir(legacyPath, storagePath)) {
    log.info('Vault inherited the legacy CRDT store', { vaultUuid, legacyPath, storagePath })
  } else {
    // The claim stands, so the next launch of this vault retries and no other
    // vault can take the store in the meantime.
    log.warn('Could not move the legacy CRDT store; will retry on the next launch', {
      vaultUuid,
      legacyPath,
      storagePath
    })
  }
}

/**
 * Settle the partition the claim owes, if this vault is the one that owes it.
 *
 * Driven by the durable record rather than by the move that preceded it, so a
 * launch that crashed between the two still gets here. It is deliberately not
 * gated on the legacy directory: by this point that directory is usually gone,
 * and the documents to set aside are in this vault's own store.
 */
export async function partitionInheritedLegacyStore({
  vaultUuid,
  storagePath
}: VaultCrdtStore): Promise<void> {
  if (getLegacyCrdtStorePartitionPending() !== vaultUuid) return
  // The move has not happened yet (it failed, and `inheritLegacyCrdtStore`
  // logged why). Stay pending: the next launch moves, then partitions.
  if (!existsSync(storagePath)) return

  if (await setAsideAmbiguousLegacyDocs(storagePath)) {
    clearLegacyCrdtStorePartitionPending()
  }
}

/**
 * Rename this vault's store to match a uuid it has adopted since the store was
 * last opened.
 *
 * The uuid is resolved once, when the provider opens the store, and device
 * linking rewrites it in place afterwards (`adoptVaultLocally`) — so nothing
 * breaks for the rest of that session, and then the *next* open looks under the
 * adopted name, finds nothing, and every note re-seeds from markdown as an
 * independent insertion instead of merging with the history it already had.
 * `resetVaultUuidCache()` exists in that same function for exactly this class of
 * reason; the store directory is the same problem one layer out.
 *
 * Safe to do here and nowhere else: this runs immediately before the store is
 * opened, and the provider that held the previous directory has always been
 * destroyed by then — `closeVault` awaits `destroy()` (which closes LevelDB)
 * before `resetCrdtProvider()`, and a still-initialized provider never re-enters
 * `initPersistence`. Moving the directory underneath an open LevelDB lock, which
 * is what doing it inside the linking flow would mean, is never attempted.
 *
 * Crash safety is the same shape as the legacy claim's. The record is written
 * before the uuid it describes, and it — not the directory, which the failed
 * launch may or may not have moved — is what drives this:
 *
 *  - crash after the record, before the uuid rewrite → the vault still has its
 *    old uuid, so this never fires and the store opens where it always was;
 *  - crash after the rewrite, before or during the move → the record still
 *    names the old directory, so the next open finishes the move;
 *  - crash after both → the record is cleared and there is nothing to redo.
 *
 * A half-move cannot lose data: `moveStoreDir` is a rename, and its copy
 * fallback deletes the destination rather than leaving two halves.
 */
export async function settlePendingCrdtStoreRename({
  vaultUuid,
  storagePath
}: VaultCrdtStore): Promise<void> {
  const previousUuid = getPendingCrdtStoreRename(vaultUuid)
  if (previousUuid === undefined) return

  const previousPath = vaultCrdtStorePath(previousUuid)
  if (!existsSync(previousPath)) {
    // The vault adopted a uuid without ever having opened a store under its own
    // — a vault provisioned for linking (`createDormantVault`) is the ordinary
    // way to get here. There is nothing to move and never will be.
    clearPendingCrdtStoreRename(vaultUuid)
    return
  }

  if (existsSync(storagePath)) {
    // Two local vaults have ended up claiming one uuid, or a previous move fell
    // back to copy+delete and the delete failed. Either way the destination is
    // somebody's history: moving on top of it would destroy that instead of the
    // duplicate. Stay pending — deleting the leftover by hand is a recovery, and
    // this then completes on the next open.
    log.warn('Pre-adoption CRDT store left in place: the adopted uuid already has a store', {
      vaultUuid,
      previousPath,
      storagePath
    })
    return
  }

  if (await moveStoreDir(previousPath, storagePath)) {
    clearPendingCrdtStoreRename(vaultUuid)
    log.info('CRDT store followed the vault uuid it adopted', {
      vaultUuid,
      previousUuid,
      storagePath
    })
  } else {
    // The record stands, so the next open retries rather than opening an empty
    // store next to a full one.
    log.warn('Could not move the pre-adoption CRDT store; will retry on the next open', {
      vaultUuid,
      previousPath,
      storagePath
    })
  }
}

/**
 * Resolve the open vault's store, create its parent directory, and settle the
 * legacy-store migration — everything that has to happen before the store is
 * opened. Null when no vault is open yet.
 */
export async function prepareVaultCrdtStore(): Promise<VaultCrdtStore | null> {
  const target = resolveVaultCrdtStore()
  if (!target) return null

  try {
    // Both the rename below and the preflight child need the parent to exist;
    // LevelDB only ever creates the leaf.
    mkdirSync(path.dirname(target.storagePath), { recursive: true })
  } catch (err) {
    log.warn('Could not create the CRDT store root directory', {
      storagePath: target.storagePath,
      error: err
    })
  }

  // Before the legacy inherit, because both want to move a directory into this
  // vault's name and only one can. The pre-adoption store is history this vault
  // provably wrote itself; the legacy store is history it can only *claim*, and
  // whose ownership is ambiguous enough that half of it may have to be set
  // aside. When the two collide — only reachable when a legacy move already
  // failed once — the unambiguous one wins and the legacy store stays put.
  await settlePendingCrdtStoreRename(target)
  await inheritLegacyCrdtStore(target)
  await partitionInheritedLegacyStore(target)
  return target
}
