import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAdapterConformance } from '@memry/sync-client/adapters/conformance'
import type { SyncPlatformAdapters } from '@memry/sync-client/adapters'
import { NetworkMonitor } from '../network'
import {
  DesktopVaultFileSystem,
  directoryVaultRoots,
  DesktopAttachmentStore,
  DesktopCrdtStorePath,
  DesktopCrdtPreflight,
  accessProbe,
  DesktopDeviceRegistration,
  fileSigningKeyStore,
  DesktopSyncHttpClient,
  DesktopCertificatePinning,
  DesktopRuntime
} from './index'

/**
 * T020/T023: the shared conformance suite against the REAL desktop adapters
 * under node — real fs in a scratch directory, real Ed25519 via libsodium,
 * the real NetworkMonitor (with injected node-safe sources, since electron's
 * net/powerMonitor do not exist under vitest).
 *
 * App-state-bound injections, each the seam between generic adapter and
 * desktop's runtime rather than a mock of behaviour under test:
 * - device id / device info / app version are constants (production reads the
 *   sync_devices row and app.getVersion via `wiring.ts`),
 * - the preflight probe is `accessProbe` (production runs the child-process
 *   `runCrdtPreflight`, which needs the electron binary),
 * - pinning's disabled-check reports disabled (dev/test posture, matching
 *   `isPinningDisabled`'s non-electron fallback).
 *
 * skip justifications (each required by the harness contract):
 * - `crdtPersistence`, `crdtProvider`: their desktop adapters land with T019
 *   (the CRDT extraction slice, in flight in this same phase) — not a drift,
 *   a sequencing.
 */
const scratchDirs: string[] = []

const createAdapters = (): SyncPlatformAdapters => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'memry-adapter-conformance-'))
  scratchDirs.push(scratch)

  const crdtStoreDirFor = async (vaultId: string): Promise<string> =>
    path.join(scratch, 'crdt-stores', vaultId)
  const monitor = new NetworkMonitor(0, {
    getIsOnline: () => true,
    onResume: () => undefined,
    onSuspend: () => undefined,
    offResume: () => undefined,
    offSuspend: () => undefined
  })

  const adapters = {
    http: new DesktopSyncHttpClient({
      baseUrl: () => 'http://localhost:0',
      online: {
        onStatusChanged: (cb) => {
          const handler = ({ online }: { online: boolean }): void => cb(online)
          monitor.on('status-changed', handler)
          return () => {
            monitor.off('status-changed', handler)
          }
        }
      }
    }),
    certificatePinning: new DesktopCertificatePinning(() => true),
    crdtStorePath: new DesktopCrdtStorePath((vaultId) =>
      path.join(scratch, 'crdt-stores', vaultId)
    ),
    attachmentStore: new DesktopAttachmentStore(async (vaultId) =>
      path.join(scratch, 'attachments', vaultId)
    ),
    vaultFileSystem: new DesktopVaultFileSystem(
      directoryVaultRoots(path.join(scratch, 'vaults'))
    ),
    deviceRegistration: new DesktopDeviceRegistration({
      deviceId: async () => 'conformance-device',
      deviceInfo: async () => ({
        platform: 'desktop' as const,
        model: 'node-conformance',
        appVersion: '0.0.0-conformance'
      }),
      keyStore: fileSigningKeyStore(path.join(scratch, 'keys'))
    }),
    crdtPreflight: new DesktopCrdtPreflight(crdtStoreDirFor, accessProbe),
    runtime: new DesktopRuntime({
      appVersion: () => '0.0.0-conformance',
      onForeground: () => () => undefined,
      onBackground: () => () => undefined
    })
  }
  // The two skipped CRDT seams are absent by declaration; the harness's skip
  // list is the typed channel for that.
  return adapters as unknown as SyncPlatformAdapters
}

runAdapterConformance(
  {
    create: createAdapters,
    destroy: () => {
      const scratch = scratchDirs.pop()
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    },
    skip: ['crdtPersistence', 'crdtProvider']
  },
  { describe, it, expect }
)
