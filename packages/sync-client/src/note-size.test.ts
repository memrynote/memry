import { describe, expect, it } from 'vitest'
import {
  classifyNoteSyncSize,
  ItemTooLargeError,
  NOTE_SYNC_MAX_BYTES,
  NOTE_SYNC_WARN_BYTES,
  SYNC_ITEM_ENCRYPT_OVERHEAD,
  SYNC_ITEM_MAX_ENCRYPT_BYTES
} from './note-size'

describe('note sync size ceiling', () => {
  it('#then the ceiling is the largest payload the encrypt cap still accepts', () => {
    expect(NOTE_SYNC_MAX_BYTES * SYNC_ITEM_ENCRYPT_OVERHEAD).toBeLessThanOrEqual(
      SYNC_ITEM_MAX_ENCRYPT_BYTES
    )
    expect((NOTE_SYNC_MAX_BYTES + 1) * SYNC_ITEM_ENCRYPT_OVERHEAD).toBeGreaterThan(
      SYNC_ITEM_MAX_ENCRYPT_BYTES
    )
  })

  it('#then a note over the ceiling is "over"', () => {
    expect(classifyNoteSyncSize(NOTE_SYNC_MAX_BYTES + 1)).toBe('over')
  })

  it('#then a note exactly at the ceiling still syncs', () => {
    expect(classifyNoteSyncSize(NOTE_SYNC_MAX_BYTES)).toBe('approaching')
  })

  it('#then a note in the warn band is "approaching"', () => {
    expect(classifyNoteSyncSize(NOTE_SYNC_WARN_BYTES)).toBe('approaching')
    expect(classifyNoteSyncSize(NOTE_SYNC_MAX_BYTES - 1)).toBe('approaching')
  })

  it('#then an ordinary note is "ok"', () => {
    expect(classifyNoteSyncSize(0)).toBe('ok')
    expect(classifyNoteSyncSize(2_048)).toBe('ok')
    expect(classifyNoteSyncSize(NOTE_SYNC_WARN_BYTES - 1)).toBe('ok')
  })

  it('#then ItemTooLargeError reports the item and keeps the logged message shape', () => {
    const err = new ItemTooLargeError('note-1', 24_000_000, SYNC_ITEM_MAX_ENCRYPT_BYTES)
    expect(err).toBeInstanceOf(Error)
    expect(err.itemId).toBe('note-1')
    expect(err.code).toBe('item_too_large')
    expect(err.message).toBe('Item too large for sync (estimated 22.9MB, max 5MB)')
  })
})
