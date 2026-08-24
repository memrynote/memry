import { promises as fsp } from 'node:fs'
import type { CrdtStorePathAdapter } from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 4.
 *
 * The real per-vault store root comes from userData (`crdt-store-path.ts`'s
 * `vaultCrdtStorePath`), which is electron-bound and therefore injected via
 * `storeRootFor` — see `wiring.ts`. `ensureExists` is plain recursive mkdir,
 * which is what desktop's store preparation already does.
 */
export class DesktopCrdtStorePath implements CrdtStorePathAdapter {
  constructor(private readonly storeRootForVault: (vaultId: string) => string) {}

  async storeRootFor(vaultId: string): Promise<string> {
    return this.storeRootForVault(vaultId)
  }

  async ensureExists(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true })
  }
}
