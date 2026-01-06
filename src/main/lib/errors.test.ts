import { describe, it, expect } from 'vitest'
import {
  VaultError,
  VaultErrorCode,
  NoteError,
  NoteErrorCode,
  DatabaseError,
  DatabaseErrorCode,
  WatcherError,
  WatcherErrorCode,
  isVaultError,
  isNoteError,
  isDatabaseError,
  isWatcherError
} from './errors'

describe('errors', () => {
  it('VaultError stores message, code, and name for all codes', () => {
    Object.values(VaultErrorCode).forEach((code) => {
      const err = new VaultError('vault failure', code)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('VaultError')
      expect(err.message).toBe('vault failure')
      expect(err.code).toBe(code)
    })
  })

  it('NoteError stores message, code, name, and optional noteId', () => {
    Object.values(NoteErrorCode).forEach((code) => {
      const err = new NoteError('note failure', code, 'note123')
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('NoteError')
      expect(err.message).toBe('note failure')
      expect(err.code).toBe(code)
      expect(err.noteId).toBe('note123')
    })
  })

  it('DatabaseError stores message, code, and name for all codes', () => {
    Object.values(DatabaseErrorCode).forEach((code) => {
      const err = new DatabaseError('db failure', code)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('DatabaseError')
      expect(err.message).toBe('db failure')
      expect(err.code).toBe(code)
    })
  })

  it('WatcherError stores message, code, and name for all codes', () => {
    Object.values(WatcherErrorCode).forEach((code) => {
      const err = new WatcherError('watcher failure', code)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('WatcherError')
      expect(err.message).toBe('watcher failure')
      expect(err.code).toBe(code)
    })
  })

  it('type guards identify their respective error instances', () => {
    expect(isVaultError(new VaultError('vault', VaultErrorCode.NOT_FOUND))).toBe(true)
    expect(isNoteError(new NoteError('note', NoteErrorCode.NOT_FOUND))).toBe(true)
    expect(isDatabaseError(new DatabaseError('db', DatabaseErrorCode.QUERY_FAILED))).toBe(
      true
    )
    expect(isWatcherError(new WatcherError('watch', WatcherErrorCode.EVENT_ERROR))).toBe(
      true
    )

    const generic = new Error('generic')
    expect(isVaultError(generic)).toBe(false)
    expect(isNoteError(generic)).toBe(false)
    expect(isDatabaseError(generic)).toBe(false)
    expect(isWatcherError(generic)).toBe(false)
  })
})
