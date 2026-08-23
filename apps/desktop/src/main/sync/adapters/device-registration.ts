import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import sodium from 'libsodium-wrappers-sumo'
import type {
  DeviceInfo,
  DeviceRegistrationAdapter,
  DeviceSigner
} from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 7.
 *
 * The device id and description come from app state (the sync_devices row and
 * app version), so they are injected. The signing material is real Ed25519 via
 * libsodium; WHERE the keypair persists is a `SigningKeyStore`, because
 * desktop's production key handling is account/keychain-bound while the
 * conformance run persists to a scratch directory. Key material never leaves
 * this module raw: callers get a `sign` closure, not the private key.
 */
export interface StoredSigningKeypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface SigningKeyStore {
  load(vaultId: string): Promise<StoredSigningKeypair | null>
  save(vaultId: string, keypair: StoredSigningKeypair): Promise<void>
}

/** File-backed store — scratch/testing use; production wiring supplies its own. */
export function fileSigningKeyStore(dir: string): SigningKeyStore {
  const fileFor = (vaultId: string): string =>
    path.join(dir, `${createHash('sha256').update(vaultId).digest('hex').slice(0, 32)}.json`)
  return {
    async load(vaultId) {
      try {
        const raw = JSON.parse(await fsp.readFile(fileFor(vaultId), 'utf8')) as {
          publicKey: string
          privateKey: string
        }
        return {
          publicKey: Uint8Array.from(Buffer.from(raw.publicKey, 'base64')),
          privateKey: Uint8Array.from(Buffer.from(raw.privateKey, 'base64'))
        }
      } catch {
        return null
      }
    },
    async save(vaultId, keypair) {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(
        fileFor(vaultId),
        JSON.stringify({
          publicKey: Buffer.from(keypair.publicKey).toString('base64'),
          privateKey: Buffer.from(keypair.privateKey).toString('base64')
        })
      )
    }
  }
}

export interface DesktopDeviceRegistrationDeps {
  deviceId(): Promise<string>
  deviceInfo(): Promise<DeviceInfo>
  keyStore: SigningKeyStore
}

export class DesktopDeviceRegistration implements DeviceRegistrationAdapter {
  constructor(private readonly deps: DesktopDeviceRegistrationDeps) {}

  deviceId(): Promise<string> {
    return this.deps.deviceId()
  }

  deviceInfo(): Promise<DeviceInfo> {
    return this.deps.deviceInfo()
  }

  async signingKeypair(vaultId: string): Promise<DeviceSigner> {
    await sodium.ready
    let keypair = await this.deps.keyStore.load(vaultId)
    if (!keypair) {
      const generated = sodium.crypto_sign_keypair()
      keypair = { publicKey: generated.publicKey, privateKey: generated.privateKey }
      await this.deps.keyStore.save(vaultId, keypair)
    }
    const { publicKey, privateKey } = keypair
    return {
      publicKey,
      sign: async (msg: Uint8Array) => sodium.crypto_sign_detached(msg, privateKey)
    }
  }
}
