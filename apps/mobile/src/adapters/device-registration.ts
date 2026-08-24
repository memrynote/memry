import * as Device from 'expo-device'
import type {
  DeviceInfo,
  DeviceRegistrationAdapter,
  DeviceSigner
} from '@memry/sync-client/adapters'
import { generateDeviceSigningKeyPair, signDetached } from '../crypto/libsodium'
import {
  getDeviceSigningKeypair,
  getOrCreateDeviceId,
  setDeviceSigningKeypair
} from '../lib/secure-store'
import { mobileAppVersion } from './runtime'

/**
 * Seam 7 on mobile: identity in expo-secure-store. The signing keypair is
 * generated on device, stored WHEN_UNLOCKED_THIS_DEVICE_ONLY, and never
 * crosses this interface raw — callers get a `sign` closure.
 */
export function createMobileDeviceRegistration(): DeviceRegistrationAdapter {
  return {
    async deviceId() {
      return getOrCreateDeviceId()
    },

    async deviceInfo(): Promise<DeviceInfo> {
      return {
        platform: 'ios',
        model: Device.modelName ?? 'iPhone',
        appVersion: mobileAppVersion()
      }
    },

    async signingKeypair(vaultId): Promise<DeviceSigner> {
      let stored = await getDeviceSigningKeypair(vaultId)
      if (!stored) {
        const generated = await generateDeviceSigningKeyPair()
        stored = { publicKey: generated.publicKey, privateKey: generated.secretKey }
        await setDeviceSigningKeypair(vaultId, stored)
      }
      const privateKey = stored.privateKey
      return {
        publicKey: stored.publicKey,
        async sign(msg) {
          return signDetached(msg, privateKey)
        }
      }
    }
  }
}
