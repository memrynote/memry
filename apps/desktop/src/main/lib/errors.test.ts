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

  it('NoteError preserves the originating error as cause', () => {
    // #given a native fs failure carrying the errno we need for diagnosis
    const cause = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })

    // #when it is wrapped in a NoteError
    const err = new NoteError('note failure', NoteErrorCode.WRITE_FAILED, undefined, { cause })

    // #then the original error survives the wrap
    expect(err.cause).toBe(cause)
  })

  it('NoteError telemetry code carries the errno, never the file path', () => {
    // #given an fs failure whose message embeds a private vault path
    const cause = Object.assign(
      new Error("EBUSY: resource busy, rename '/Users/kaan/OneDrive/vault/secret.md'"),
      { code: 'EBUSY' }
    )

    // #when building the telemetry code
    const err = new NoteError('write failed', NoteErrorCode.WRITE_FAILED, undefined, { cause })

    // #then the errno is exposed and nothing path-derived leaks
    expect(err.telemetryCode).toBe('NOTE_WRITE_FAILED:EBUSY')
    expect(err.telemetryCode).not.toContain('secret.md')
    expect(err.telemetryCode).not.toContain('/')
  })

  it('NoteError telemetry code falls back to the bare code without an errno', () => {
    expect(new NoteError('missing', NoteErrorCode.NOT_FOUND).telemetryCode).toBe('NOTE_NOT_FOUND')
    expect(
      new NoteError('write failed', NoteErrorCode.WRITE_FAILED, undefined, {
        cause: new Error('no errno here')
      }).telemetryCode
    ).toBe('NOTE_WRITE_FAILED')
  })

  it('NoteError telemetry code rejects a path-shaped errno', () => {
    // #given a cause whose `code` is not an errno at all but a path
    // (some libraries reuse `code`; it must never reach telemetry)
    const cause = Object.assign(new Error('bad'), { code: '/Users/kaan/vault/secret.md' })

    // #when building the telemetry code
    const err = new NoteError('write failed', NoteErrorCode.WRITE_FAILED, undefined, { cause })

    // #then the unrecognised value is dropped rather than forwarded
    expect(err.telemetryCode).toBe('NOTE_WRITE_FAILED')
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
    expect(isDatabaseError(new DatabaseError('db', DatabaseErrorCode.QUERY_FAILED))).toBe(true)
    expect(isWatcherError(new WatcherError('watch', WatcherErrorCode.EVENT_ERROR))).toBe(true)

    const generic = new Error('generic')
    expect(isVaultError(generic)).toBe(false)
    expect(isNoteError(generic)).toBe(false)
    expect(isDatabaseError(generic)).toBe(false)
    expect(isWatcherError(generic)).toBe(false)
  })
})
