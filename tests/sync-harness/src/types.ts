import type { SyncItemType } from '@memry/contracts/sync-api'

export type VectorClock = Record<string, number>

export interface DeviceIdentity {
  deviceId: string
  userId: string
  signingPublicKey: Uint8Array
  signingSecretKey: Uint8Array
  authPublicKeyBase64: string
  vaultKey: Uint8Array
  accessToken: string
}

export interface SyncItem {
  id: string
  type: SyncItemType
  content: Record<string, unknown>
  clock: VectorClock
  operation: 'create' | 'update' | 'delete'
  deletedAt?: number
}

export interface ChaosConfig {
  seed?: number
}

export type FetchFn = typeof globalThis.fetch

export interface PullItemData {
  id: string
  type: string
  operation: string
  cryptoVersion: number
  signature: string
  signerDeviceId: string
  deletedAt?: number
  clock?: VectorClock
  stateVector?: string
  blob: {
    encryptedData: string
    dataNonce: string
    encryptedKey: string
    keyNonce: string
  }
}
