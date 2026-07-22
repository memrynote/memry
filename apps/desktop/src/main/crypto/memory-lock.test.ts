import { beforeAll, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mockLog
}))

beforeAll(async () => {
  await sodium.ready
})

describe('lockKeyMaterial', () => {
  describe('#given WASM build without sodium_mlock #when locking key buffer', () => {
    it('#then returns false gracefully', () => {
      const buffer = sodium.randombytes_buf(32)
      const result = lockKeyMaterial(buffer)
      expect(result).toBe(false)
    })
  })

  describe('#given any buffer #when lockKeyMaterial called', () => {
    it('#then does not throw', () => {
      const buffer = sodium.randombytes_buf(64)
      expect(() => lockKeyMaterial(buffer)).not.toThrow()
    })
  })

  describe('#given empty buffer #when lockKeyMaterial called', () => {
    it('#then returns false without error', () => {
      const buffer = new Uint8Array(0)
      expect(lockKeyMaterial(buffer)).toBe(false)
    })
  })
})

describe('unlockKeyMaterial', () => {
  describe('#given WASM build without sodium_munlock #when unlocking buffer', () => {
    it('#then returns false gracefully', () => {
      const buffer = sodium.randombytes_buf(32)
      const result = unlockKeyMaterial(buffer)
      expect(result).toBe(false)
    })
  })

  describe('#given any buffer #when unlockKeyMaterial called', () => {
    it('#then does not throw', () => {
      const buffer = sodium.randombytes_buf(32)
      expect(() => unlockKeyMaterial(buffer)).not.toThrow()
    })
  })

  describe('#given lock then unlock sequence #when called on same buffer', () => {
    it('#then both return false (no-op in WASM) without error', () => {
      const buffer = sodium.randombytes_buf(32)
      const locked = lockKeyMaterial(buffer)
      const unlocked = unlockKeyMaterial(buffer)
      expect(locked).toBe(false)
      expect(unlocked).toBe(false)
    })
  })
})

describe('unavailable-API log level', () => {
  describe('#given a WASM build with no mlock/munlock #when key material is locked', () => {
    it('#then the notice stays at debug and never reaches the warn stream', async () => {
      // #given — fresh module so the once-guards start clean
      vi.resetModules()
      mockLog.debug.mockClear()
      mockLog.warn.mockClear()
      mockLog.error.mockClear()
      const fresh = await import('./memory-lock')
      const buffer = sodium.randombytes_buf(32)

      // #when
      fresh.lockKeyMaterial(buffer)
      fresh.unlockKeyMaterial(buffer)

      // #then — expected steady state, not a fault (#846)
      expect(mockLog.debug).toHaveBeenCalledTimes(2)
      expect(mockLog.warn).not.toHaveBeenCalled()
      expect(mockLog.error).not.toHaveBeenCalled()
    })
  })
})
