/**
 * Seam 9 — store health check before the engine opens a vault.
 *
 * Desktop keeps its current preflight unchanged by the extraction (note the
 * Windows 0xC0000005 crash-on-open incident that lives behind it). Mobile is a
 * SQLite `PRAGMA quick_check` plus a schema-version assert.
 */
export type CrdtPreflightResult = { ok: true } | { ok: false; reason: string }

export interface CrdtPreflightAdapter {
  verifyStoreHealth(vaultId: string): Promise<CrdtPreflightResult>
}
