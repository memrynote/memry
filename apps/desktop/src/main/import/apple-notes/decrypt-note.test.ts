import { describe, expect, it } from 'vitest'
import { aesKeyUnwrap, createNoteDecryptor } from './decrypt-note'
import { buildBinaryPlist, lockNote, lockNoteEnvelope } from './locked-note-fixture'

const hex = (value: string): Buffer => Buffer.from(value.replace(/\s/g, ''), 'hex')

describe('aesKeyUnwrap', () => {
  it('matches the RFC 3394 128-bit test vector', () => {
    const kek = hex('000102030405060708090A0B0C0D0E0F')
    const wrapped = hex('1FA68B0A8112B447 AEF34BD8FB5A7B82 9D3E862371D2CFE5')
    expect(aesKeyUnwrap(kek, wrapped)?.toString('hex')).toBe('00112233445566778899aabbccddeeff')
  })

  it('rejects a wrong key-encrypting key', () => {
    const wrapped = hex('1FA68B0A8112B447 AEF34BD8FB5A7B82 9D3E862371D2CFE5')
    expect(aesKeyUnwrap(Buffer.alloc(16, 1), wrapped)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(aesKeyUnwrap(Buffer.alloc(16), Buffer.alloc(10))).toBeNull()
  })
})

describe('createNoteDecryptor', () => {
  const body = Buffer.from('gzipped protobuf bytes')

  describe.each([
    {
      layout: 'archived envelope (current macOS)',
      lock: (password: string) => ({ zdata: lockNoteEnvelope(password, body), legacy: null })
    },
    {
      layout: 'legacy ZCRYPTO columns',
      lock: (password: string) => {
        const { note, data } = lockNote(password, body)
        return { zdata: data, legacy: note }
      }
    }
  ])('$layout', ({ lock }) => {
    it('decrypts a note locked with the same password', () => {
      const { zdata, legacy } = lock('hunter2')
      expect(createNoteDecryptor('hunter2').decrypt(zdata, legacy)).toEqual({
        ok: true,
        data: body
      })
    })

    it('reports a wrong password without returning data', () => {
      const { zdata, legacy } = lock('hunter2')
      const decryptor = createNoteDecryptor('nope')
      expect(decryptor.decrypt(zdata, legacy)).toEqual({ ok: false, reason: 'wrong-password' })
      expect(decryptor.canUnlock(zdata, legacy)).toBe(false)
    })

    it('unlocks per note, so a mixed-password library is partly readable', () => {
      const first = lock('first')
      const second = lock('second')
      const decryptor = createNoteDecryptor('first')
      expect(decryptor.canUnlock(first.zdata, first.legacy)).toBe(true)
      expect(decryptor.canUnlock(second.zdata, second.legacy)).toBe(false)
    })
  })

  it('reports tampered ciphertext as unreadable, not as a wrong password', () => {
    const envelope = lockNoteEnvelope('hunter2', body, { tamperCiphertext: true })
    expect(createNoteDecryptor('hunter2').decrypt(envelope, null)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
    const { note, data } = lockNote('hunter2', body)
    data[0] ^= 0xff
    expect(createNoteDecryptor('hunter2').decrypt(data, note)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
  })

  it('treats a non-positive legacy iteration count as unreadable material, not a crash', () => {
    const { note, data } = lockNote('hunter2', body)
    expect(createNoteDecryptor('hunter2').decrypt(data, { ...note, iterations: 0 }).ok).toBe(false)
  })

  it('treats a bplist that is not a cipher-version-2 envelope as unreadable', () => {
    const notAnEnvelope = buildBinaryPlist({ hello: 'world', padding: Buffer.alloc(64) })
    expect(createNoteDecryptor('x').decrypt(notAnEnvelope, null)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
  })
})
