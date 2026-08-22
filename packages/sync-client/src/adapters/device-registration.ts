/**
 * Seam 7 — device identity and signing.
 *
 * Key material never crosses this interface raw beyond what desktop already
 * exposes: the adapter hands back a `sign` closure, not a private key. Mobile
 * backs it with expo-secure-store.
 */
export type DevicePlatform = 'desktop' | 'ios' | 'android'

export interface DeviceInfo {
  platform: DevicePlatform
  model: string
  appVersion: string
}

export interface DeviceSigner {
  publicKey: Uint8Array
  sign(msg: Uint8Array): Promise<Uint8Array>
}

export interface DeviceRegistrationAdapter {
  deviceId(): Promise<string>
  deviceInfo(): Promise<DeviceInfo>
  signingKeypair(vaultId: string): Promise<DeviceSigner>
}
