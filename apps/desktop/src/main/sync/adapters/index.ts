/**
 * Desktop implementations of the `@memry/sync-client` platform seams (T020).
 *
 * Adapter classes are node-importable — electron- and app-state-bound
 * dependencies are injected, with the production factories in `wiring.ts`.
 * The CRDT pair (persistence/provider) lands with T019.
 */
export { DesktopVaultFileSystem, directoryVaultRoots, type VaultRootSource } from './vault-file-system'
export { DesktopAttachmentStore } from './attachment-store'
export { DesktopCrdtStorePath } from './crdt-store-path'
export { DesktopCrdtPreflight, accessProbe, type CrdtPreflightProbe } from './crdt-preflight'
export {
  DesktopDeviceRegistration,
  fileSigningKeyStore,
  type SigningKeyStore,
  type StoredSigningKeypair
} from './device-registration'
export { DesktopSyncHttpClient, type OnlineSignalSource } from './http-client'
export { DesktopCertificatePinning } from './certificate-pinning'
export { DesktopRuntime, type DesktopRuntimeDeps } from './runtime'
export {
  createDesktopSyncAdapters,
  type DesktopAdapterWiringDeps,
  type DesktopNonCrdtAdapters
} from './wiring'
