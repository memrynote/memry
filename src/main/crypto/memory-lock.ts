import sodium from 'libsodium-wrappers-sumo'
import { createLogger } from '../lib/logger'

const log = createLogger('CryptoMemLock')
type SodiumLockApi = Record<string, unknown> & {
  sodium_mlock?: (buf: Uint8Array) => void
  sodium_munlock?: (buf: Uint8Array) => void
}

let warnedMissingMlock = false
let warnedMissingMunlock = false

const getLockFunction = (
  name: 'sodium_mlock' | 'sodium_munlock'
): ((buf: Uint8Array) => void) | null => {
  const fn = (sodium as SodiumLockApi)[name]
  return typeof fn === 'function' ? fn : null
}

export function lockKeyMaterial(buffer: Uint8Array): boolean {
  if (buffer.byteLength === 0) return false

  const mlock = getLockFunction('sodium_mlock')
  if (!mlock) {
    if (!warnedMissingMlock) {
      warnedMissingMlock = true
      log.warn(
        'sodium_mlock unavailable in WASM build. Key material will not be pinned to RAM. ' +
          'This is expected in Electron/Node.js — OS-level FDE provides equivalent swap protection.'
      )
    }
    return false
  }

  try {
    mlock(buffer)
    return true
  } catch (err) {
    log.warn('sodium_mlock failed — key material may be swappable:', err)
    return false
  }
}

export function unlockKeyMaterial(buffer: Uint8Array): boolean {
  if (buffer.byteLength === 0) return false

  const munlock = getLockFunction('sodium_munlock')
  if (!munlock) {
    if (!warnedMissingMunlock) {
      warnedMissingMunlock = true
      log.warn('sodium_munlock unavailable in WASM build. Cleanup will continue without munlock.')
    }
    return false
  }

  try {
    munlock(buffer)
    return true
  } catch (err) {
    log.warn('sodium_munlock failed:', err)
    return false
  }
}
