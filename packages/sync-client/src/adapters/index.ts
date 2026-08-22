/**
 * The ten platform seams (decision record §7, contracts/platform-adapters.md).
 *
 * These are the ONLY places platform code may live. Everything else in
 * `@memry/sync-client` is platform-free TypeScript: no node builtins, no
 * electron, no React Native. Signatures use plain TS types, `Uint8Array` for
 * bytes, and Promises for effects.
 *
 * Adding an eleventh seam requires a written justification in the PR. The
 * ten-seam list is the decision record's; drift goes through review, not
 * accretion.
 */
export type {
  SyncHttpClient,
  SyncHttpMethod,
  SyncHttpRequest,
  SyncHttpResponse
} from './http-client.ts'
export type { CertificatePinningAdapter } from './certificate-pinning.ts'
export type { CrdtDocState, CrdtPersistenceAdapter } from './crdt-persistence.ts'
export type { CrdtStorePathAdapter } from './crdt-store-path.ts'
export type { AttachmentStoreAdapter } from './attachment-store.ts'
export type { LocalVault, VaultDirectoryAdapter } from './vault-directory.ts'
export type {
  DeviceInfo,
  DevicePlatform,
  DeviceRegistrationAdapter,
  DeviceSigner
} from './device-registration.ts'
export type { CrdtProviderHost, CrdtTransport } from './crdt-provider.ts'
export type { CrdtPreflightAdapter, CrdtPreflightResult } from './crdt-preflight.ts'
export type { RuntimeAdapter } from './runtime.ts'
export type { SyncLogger } from './logger.ts'

import type { SyncHttpClient } from './http-client.ts'
import type { CertificatePinningAdapter } from './certificate-pinning.ts'
import type { CrdtPersistenceAdapter } from './crdt-persistence.ts'
import type { CrdtStorePathAdapter } from './crdt-store-path.ts'
import type { AttachmentStoreAdapter } from './attachment-store.ts'
import type { VaultDirectoryAdapter } from './vault-directory.ts'
import type { DeviceRegistrationAdapter } from './device-registration.ts'
import type { CrdtProviderHost } from './crdt-provider.ts'
import type { CrdtPreflightAdapter } from './crdt-preflight.ts'
import type { RuntimeAdapter } from './runtime.ts'

/** Everything a shell must supply for the engine to run. */
export interface SyncPlatformAdapters {
  http: SyncHttpClient
  certificatePinning: CertificatePinningAdapter
  crdtPersistence: CrdtPersistenceAdapter
  crdtStorePath: CrdtStorePathAdapter
  attachmentStore: AttachmentStoreAdapter
  vaultDirectory: VaultDirectoryAdapter
  deviceRegistration: DeviceRegistrationAdapter
  crdtProvider: CrdtProviderHost
  crdtPreflight: CrdtPreflightAdapter
  runtime: RuntimeAdapter
}

/** The seam names, in decision-record order. Used by the conformance suite. */
export const SYNC_ADAPTER_SEAMS = [
  'http',
  'certificatePinning',
  'crdtPersistence',
  'crdtStorePath',
  'attachmentStore',
  'vaultDirectory',
  'deviceRegistration',
  'crdtProvider',
  'crdtPreflight',
  'runtime'
] as const satisfies ReadonlyArray<keyof SyncPlatformAdapters>

export type SyncAdapterSeam = (typeof SYNC_ADAPTER_SEAMS)[number]
