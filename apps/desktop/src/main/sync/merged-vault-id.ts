import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'

/**
 * The `vaultId` a pulled update of a record that names its vault (canvas,
 * canvas folder, agent conversation) leaves on the stored row: the stored id,
 * unless the remote states this device's bound server vault id, which wins
 * (protocol §13.7.21 rule 4 and §13.7.23 rule 3, #5772; the Rust core's
 * `server_vault::merged_vault_id`, #5669).
 *
 * Invariant: a merge never moves a record off the bound id, and never onto any
 * id but the bound one. A Rust core restamps the records it wrote under its
 * pre-bind local id to the server vault id. A peer that pulled such a record
 * first stores the old id; keeping it over the restamp would push it again,
 * and every fresh device, which lists by its adopted server uuid
 * (`canvas/store.ts` `listCanvases`, `canvas/folder-store.ts`), would hide the
 * record. Any other remote id is another vault's and is never adopted (#5505).
 */
export function mergedVaultId(db: DrizzleDb, stored: string, remote: string | undefined): string {
  if (remote === undefined || remote === stored) return stored
  return remote === getOrCreateVaultUuid(db) ? remote : stored
}
