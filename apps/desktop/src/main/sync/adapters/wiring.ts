import { app, powerMonitor } from 'electron'
import type { SyncPlatformAdapters } from '@memry/sync-client/adapters'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { NetworkMonitor } from '../network'
import { vaultCrdtStorePath } from '../crdt-store-path'
import { isPinningDisabled, getPinnedCertificateHashes } from '../certificate-pinning'
import { runCrdtPreflight } from '../crdt-preflight'
import { resolveSyncServerUrl } from '@memry/sync-client/sync-server-url'
import { DesktopVaultFileSystem, type VaultRootSource } from './vault-file-system'
import { DesktopAttachmentStore } from './attachment-store'
import { DesktopCrdtStorePath } from './crdt-store-path'
import { DesktopCrdtPreflight } from './crdt-preflight'
import { DesktopDeviceRegistration, type SigningKeyStore } from './device-registration'
import { DesktopSyncHttpClient } from './http-client'
import { DesktopCertificatePinning } from './certificate-pinning'
import { DesktopRuntime } from './runtime'

/**
 * Production wiring for the eight non-CRDT desktop adapters: the electron- and
 * app-state-bound dependency factories live HERE, so the adapter classes stay
 * importable under plain node (which is how the conformance suite runs them).
 *
 * The CRDT pair (`crdtPersistence`, `crdtProvider`) joins when T019 lands, and
 * the engine starts consuming `SyncPlatformAdapters` in the phase after the
 * extraction — until then this factory is compiled (typecheck proves the
 * integration) but not yet called from the runtime.
 */
export interface DesktopAdapterWiringDeps {
  db: DrizzleDb
  /** The runtime's existing NetworkMonitor — its lifecycle stays with the engine. */
  network: NetworkMonitor
  /** Account/keychain-backed in production; supplied by the consumer. */
  keyStore: SigningKeyStore
  vaultRoots: VaultRootSource
  attachmentsDirFor(vaultId: string): Promise<string>
}

export type DesktopNonCrdtAdapters = Omit<
  SyncPlatformAdapters,
  'crdtPersistence' | 'crdtProvider'
>

export function createDesktopSyncAdapters(deps: DesktopAdapterWiringDeps): DesktopNonCrdtAdapters {
  const certificatePinning = new DesktopCertificatePinning(isPinningDisabled)
  certificatePinning.configure(getPinnedCertificateHashes())

  const http = new DesktopSyncHttpClient({
    baseUrl: () => resolveSyncServerUrl(),
    online: {
      onStatusChanged: (cb) => {
        const handler = ({ online }: { online: boolean }): void => cb(online)
        deps.network.on('status-changed', handler)
        return () => {
          deps.network.off('status-changed', handler)
        }
      }
    }
  })

  const runtime = new DesktopRuntime({
    appVersion: () => app.getVersion(),
    onForeground: (cb) => {
      powerMonitor.on('resume', cb)
      return () => {
        powerMonitor.removeListener('resume', cb)
      }
    },
    onBackground: (cb) => {
      powerMonitor.on('suspend', cb)
      return () => {
        powerMonitor.removeListener('suspend', cb)
      }
    }
  })

  const deviceRegistration = new DesktopDeviceRegistration({
    deviceId: async () => {
      const id = getCurrentDeviceId(deps.db)
      if (!id) throw new Error('No registered device for this vault yet')
      return id
    },
    deviceInfo: async () => ({
      platform: 'desktop',
      model: `${process.platform}-${process.arch}`,
      appVersion: app.getVersion()
    }),
    keyStore: deps.keyStore
  })

  return {
    http,
    certificatePinning,
    crdtStorePath: new DesktopCrdtStorePath((vaultId) => vaultCrdtStorePath(vaultId)),
    attachmentStore: new DesktopAttachmentStore(deps.attachmentsDirFor),
    vaultFileSystem: new DesktopVaultFileSystem(deps.vaultRoots),
    deviceRegistration,
    crdtPreflight: new DesktopCrdtPreflight(
      async (vaultId) => vaultCrdtStorePath(vaultId),
      async (storeDir) => {
        const verdict = await runCrdtPreflight(storeDir)
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
      }
    ),
    runtime
  }
}
