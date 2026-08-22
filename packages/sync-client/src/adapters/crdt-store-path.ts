/**
 * Seam 4 — where a vault's CRDT store lives.
 *
 * Desktop derives it from userData (see the `app.name` landmine: changing the
 * app name moves userData and orphans every existing store). Mobile uses the
 * vault directory inside the app sandbox.
 */
export interface CrdtStorePathAdapter {
  storeRootFor(vaultId: string): Promise<string>
  ensureExists(path: string): Promise<void>
}
