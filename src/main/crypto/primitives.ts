import sodium from 'libsodium-wrappers-sumo'
import { unlockKeyMaterial } from './memory-lock'

export const generateFileKey = (): Uint8Array => {
  return sodium.randombytes_buf(32)
}

export const secureCleanup = (...buffers: Uint8Array[]): void => {
  for (const buffer of buffers) {
    unlockKeyMaterial(buffer)
    sodium.memzero(buffer)
  }
}
