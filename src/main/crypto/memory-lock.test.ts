import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'

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
