import path from 'path'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import { moveStoreDir } from './crdt-store-move'
import { getLegacyCrdtStoreClaim, recordLegacyCrdtStoreClaim } from '../store'
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
    return {
      vaultUuid,
      storagePath: path.join(app.getPath('userData'), STORE_ROOT_DIRNAME, storeDirName(vaultUuid))
    }
  } catch (err) {
    log.error('Could not resolve the vault CRDT store path', { error: err })
    return null
  }
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
 * The claim is written before the move, which makes the whole thing crash-safe:
 *
 *  - crash after the claim, before the move → the legacy directory is still
 *    there and still claimed by this vault, so the next launch of the *same*
 *    vault finishes the move and no other vault may touch it;
 *  - crash after the move → the directory is gone, so there is nothing left to
 *    inherit and nothing to double-apply.
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
    recordLegacyCrdtStoreClaim(vaultUuid)
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

  await inheritLegacyCrdtStore(target)
  return target
}
