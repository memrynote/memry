import { promises as fsp } from 'node:fs'
import type { CrdtPreflightAdapter, CrdtPreflightResult } from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 9.
 *
 * Desktop's real probe (`runCrdtPreflight`) spawns an isolated child because
 * of the Windows 0xC0000005 crash-on-open incident; it is electron-bound and
 * injected via `wiring.ts`. The probe seam here keeps the adapter itself
 * node-testable: `verifyStoreHealth` resolves the store directory and maps the
 * probe's verdict onto the seam's result shape.
 */
export type CrdtPreflightProbe = (
  storeDir: string
) => Promise<{ ok: boolean; reason?: string | undefined }>

/**
 * Shallow structural probe used where the child-process probe cannot run
 * (node-run conformance): a store that does not exist yet is healthy by
 * vacancy (first open of a fresh vault), an unreadable one is not.
 */
export const accessProbe: CrdtPreflightProbe = async (storeDir) => {
  try {
    const stat = await fsp.stat(storeDir)
    if (!stat.isDirectory()) return { ok: false, reason: 'store path is not a directory' }
    await fsp.readdir(storeDir)
    return { ok: true }
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export class DesktopCrdtPreflight implements CrdtPreflightAdapter {
  constructor(
    private readonly storeDirFor: (vaultId: string) => Promise<string>,
    private readonly probe: CrdtPreflightProbe
  ) {}

  async verifyStoreHealth(vaultId: string): Promise<CrdtPreflightResult> {
    const dir = await this.storeDirFor(vaultId)
    const verdict = await this.probe(dir)
    if (verdict.ok) return { ok: true }
    return { ok: false, reason: verdict.reason ?? 'CRDT store preflight failed' }
  }
}
