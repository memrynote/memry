/**
 * Seam 5 — attachment bytes on disk.
 *
 * Bytes are always files, on both shells. The lazy / Wi-Fi-only download
 * POLICY lives in the shared engine (via `SyncHttpClient.isMetered()`); this
 * adapter only stores. Platform file protection (NSFileProtection on iOS) is
 * applied at write time by the implementation.
 */
export interface AttachmentStoreAdapter {
  writeBytes(vaultId: string, attachmentId: string, bytes: Uint8Array): Promise<{ path: string }>
  readBytes(vaultId: string, attachmentId: string): Promise<Uint8Array | null>
  exists(vaultId: string, attachmentId: string): Promise<boolean>
  delete(vaultId: string, attachmentId: string): Promise<void>
}
