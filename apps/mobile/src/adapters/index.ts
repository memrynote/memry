import type { SyncPlatformAdapters } from '@memry/sync-client/adapters'
import type { VaultDb } from '../db/index'
import { createMobileAttachmentStore } from './attachment-store'
import { createMobileCertificatePinning } from './certificate-pinning'
import { createMobileCrdtPersistence } from './crdt-persistence'
import { createMobileCrdtPreflight } from './crdt-preflight'
import { createMobileCrdtProviderHost } from './crdt-provider'
import { createMobileCrdtStorePath } from './crdt-store-path'
import { createMobileDeviceRegistration } from './device-registration'
import { createMobileHttpClient } from './http-client'
import { createMobileRuntime } from './runtime'
import { createMobileVaultFileSystem } from './vault-file-system'
import { syncBaseUrl } from '../sync/server-config'

/**
 * The full ten-seam adapter set (contracts/platform-adapters.md). This is the
 * object the shared conformance suite (T023/T054) runs against on-device —
 * real adapters, never mocks.
 */
export function createMobileAdapters(db: VaultDb): SyncPlatformAdapters {
  return {
    http: createMobileHttpClient(syncBaseUrl()),
    certificatePinning: createMobileCertificatePinning(),
    crdtPersistence: createMobileCrdtPersistence(db),
    crdtStorePath: createMobileCrdtStorePath(),
    attachmentStore: createMobileAttachmentStore(),
    vaultFileSystem: createMobileVaultFileSystem(),
    deviceRegistration: createMobileDeviceRegistration(),
    crdtProvider: createMobileCrdtProviderHost(),
    crdtPreflight: createMobileCrdtPreflight(),
    runtime: createMobileRuntime()
  }
}
