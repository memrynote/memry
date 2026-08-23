import { Directory } from 'expo-file-system'
import type { CrdtStorePathAdapter } from '@memry/sync-client/adapters'
import { vaultDir } from '../db/index'

/**
 * Seam 4 on mobile: the CRDT store lives inside the vault directory in the
 * app sandbox (no userData / app.name landmine here — the path is derived
 * from the vault id alone).
 */
export function createMobileCrdtStorePath(): CrdtStorePathAdapter {
  return {
    async storeRootFor(vaultId) {
      return new Directory(vaultDir(vaultId), 'crdt').uri
    },
    async ensureExists(path) {
      const dir = new Directory(path)
      if (!dir.exists) dir.create({ intermediates: true })
    }
  }
}
