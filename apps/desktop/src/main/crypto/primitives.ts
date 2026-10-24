import sodiumModule from 'libsodium-wrappers-sumo'
import { unlockKeyMaterial } from './memory-lock'

// Default import kept: tests mock this module with a default-only factory.
const sodium = sodiumModule

export const generateFileKey = (): Uint8Array => {
  return sodium.randombytes_buf(32)
}

export const secureCleanup = (...buffers: Uint8Array[]): void => {
  for (const buffer of buffers) {
    try {
      unlockKeyMaterial(buffer)
    } finally {
      sodium.memzero(buffer)
    }
  }
}
