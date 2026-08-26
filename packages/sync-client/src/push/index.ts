/**
 * The write half of the platform-free sync client (spec 001-mobile-app, US2).
 *
 * Pull landed first (Phase 3); this is its inverse, built the same way — the
 * encryption twins mirror desktop's byte-for-byte, and every platform call
 * goes through an injected provider so the module runs unchanged on Hermes.
 */
export type { SyncPushCryptoProvider } from './crypto-provider.ts'
export { encryptRecordForPush, type EncryptRecordInput } from './record-encrypt.ts'
export { encryptCrdtUpdatePacked } from './crdt-encrypt.ts'
export {
  encryptAttachmentManifest,
  decryptAttachmentManifest,
  ManifestSignatureError,
  type AttachmentChunkRef,
  type AttachmentManifest,
  type EncryptedAttachmentManifest
} from './attachment-manifest.ts'
