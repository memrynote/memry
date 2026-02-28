import sodium from 'libsodium-wrappers-sumo'
import { createLogger } from '../lib/logger'

const log = createLogger('CryptoMemLock')

const hasMlock = typeof (sodium as Record<string, unknown>).sodium_mlock === 'function'
const hasMunlock = typeof (sodium as Record<string, unknown>).sodium_munlock === 'function'

if (!hasMlock) {
  log.warn(
    'sodium_mlock unavailable in WASM build. Key material will not be pinned to RAM. ' +
      'This is expected in Electron/Node.js — OS-level FDE provides equivalent swap protection.'
  )
}

export function lockKeyMaterial(buffer: Uint8Array): boolean {
  if (!hasMlock) return false

  try {
    ;(sodium as Record<string, unknown> & { sodium_mlock: (buf: Uint8Array) => void }).sodium_mlock(
      buffer
    )
    return true
  } catch (err) {
    log.warn('sodium_mlock failed — key material may be swappable:', err)
    return false
  }
}

export function unlockKeyMaterial(buffer: Uint8Array): boolean {
  if (!hasMunlock) return false

  try {
    ;(
      sodium as Record<string, unknown> & { sodium_munlock: (buf: Uint8Array) => void }
    ).sodium_munlock(buffer)
    return true
  } catch (err) {
    log.warn('sodium_munlock failed:', err)
    return false
  }
}
