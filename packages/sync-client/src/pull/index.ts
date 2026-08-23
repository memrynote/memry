/**
 * Pull-only sync engine on the ten seams (T045 owner decision (b),
 * 2026-08-23). Consumed by mobile; desktop keeps its own engine unchanged.
 */
export type { SyncCryptoProvider } from './crypto-provider.ts'
export { encodeCbor } from './cbor.ts'
export {
  decryptRecordItem,
  decryptCrdtUpdatePacked,
  SignatureVerificationError,
  type RecordDecryptInput
} from './record-decrypt.ts'
export { buildClientHeaderValue, isParseableClientHeader, CLIENT_HEADER } from './client-header.ts'
export {
  seamJsonRequest,
  SYNC_TYPES_HEADER,
  VAULT_ID_HEADER,
  type SeamHttpContext
} from './http.ts'
export type { DecodedRecordItem, RecordItemRef, PullStore, CrdtPullStore } from './store.ts'
export {
  RecordPullEngine,
  sortByApplyOrder,
  type PullEngineDeps,
  type PullRunResult
} from './engine.ts'
export { CrdtBodyPuller, type CrdtPullDeps, type CrdtPullResult } from './crdt-pull.ts'
