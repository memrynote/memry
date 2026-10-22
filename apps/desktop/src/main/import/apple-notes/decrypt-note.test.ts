import { describe, expect, it } from 'vitest'
import { aesKeyUnwrap, createNoteDecryptor } from './decrypt-note'
import { lockNote } from './locked-note-fixture'

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

  it('decrypts a note locked with the same password', () => {
    const { note, data } = lockNote('hunter2', body)
    const result = createNoteDecryptor('hunter2').decrypt(note, data)
    expect(result).toEqual({ ok: true, data: body })
  })

  it('reports a wrong password without returning data', () => {
    const { note, data } = lockNote('hunter2', body)
    const decryptor = createNoteDecryptor('nope')
    expect(decryptor.decrypt(note, data)).toEqual({ ok: false, reason: 'wrong-password' })
    expect(decryptor.canUnlock(note)).toBe(false)
  })

  it('reports tampered ciphertext as unreadable, not as a wrong password', () => {
    const { note, data } = lockNote('hunter2', body)
    data[0] ^= 0xff
    expect(createNoteDecryptor('hunter2').decrypt(note, data)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
  })

  it('treats a non-positive iteration count as unreadable material, not a crash', () => {
    const { note, data } = lockNote('hunter2', body)
    expect(createNoteDecryptor('hunter2').decrypt({ ...note, iterations: 0 }, data).ok).toBe(false)
  })

  it('unlocks per note, so a mixed-password library is partly readable', () => {
    const a = lockNote('first', body)
    const b = lockNote('second', body)
    const decryptor = createNoteDecryptor('first')
    expect(decryptor.canUnlock(a.note)).toBe(true)
    expect(decryptor.canUnlock(b.note)).toBe(false)
  })
})
