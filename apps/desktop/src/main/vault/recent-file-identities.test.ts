/**
 * The identity keys the watcher hands an unlink expire: a key no change holds
 * lives WRITE_KEY_TTL_MS, a change's key lives until CHANGE_KEY_GRACE_MS after
 * its debounced change ran, so a note edited long ago carries none.
 *
 * @module vault/recent-file-identities.test
 */

import type { Stats } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHANGE_KEY_GRACE_MS,
  RecentFileIdentities,
  WRITE_KEY_TTL_MS
} from './recent-file-identities'
import { buildFileIdentityKey } from './rename-tracker'

function statsOf(size: number, ino = 42): Stats {
  return {
    dev: 1,
    ino,
    birthtime: new Date('2026-01-10T00:00:00.000Z'),
    birthtimeMs: Date.parse('2026-01-10T00:00:00.000Z'),
    ctimeMs: Date.parse('2026-01-12T00:00:00.000Z'),
    size,
    mtime: new Date('2026-01-12T00:00:00.000Z')
  } as Stats
}

describe('RecentFileIdentities', () => {
  let identities: RecentFileIdentities

  beforeEach(() => {
    vi.useFakeTimers()
    identities = new RecentFileIdentities()
  })

  afterEach(() => {
    identities.clear()
    vi.useRealTimers()
  })

  it('drops a raw write key no change claimed after WRITE_KEY_TTL_MS', () => {
    identities.recordWrite('/v/a.md', statsOf(10))
    vi.advanceTimersByTime(WRITE_KEY_TTL_MS - 1)
    expect(identities.take('/v/a.md')).toBe(buildFileIdentityKey(statsOf(10)))

    identities.recordWrite('/v/a.md', statsOf(10))
    vi.advanceTimersByTime(WRITE_KEY_TTL_MS)
    expect(identities.take('/v/a.md')).toBeNull()
  })

  it('holds a change key until CHANGE_KEY_GRACE_MS after its debounced change ran', () => {
    const changeRanThenWait = (filePath: string, wait: number) => {
      identities.recordChange(filePath, statsOf(11))
      vi.advanceTimersByTime(WRITE_KEY_TTL_MS * 5)
      const release = identities.changeRan(filePath)
      // A write while the change runs updates the held key.
      identities.recordWrite(filePath, statsOf(12))
      vi.advanceTimersByTime(WRITE_KEY_TTL_MS * 5)
      release()
      vi.advanceTimersByTime(wait)
      return identities.take(filePath)
    }

    expect(changeRanThenWait('/v/a.md', CHANGE_KEY_GRACE_MS - 1)).toBe(
      buildFileIdentityKey(statsOf(12))
    )
    expect(changeRanThenWait('/v/b.md', CHANGE_KEY_GRACE_MS)).toBeNull()
  })

  it('keeps a newer change key when an older debounced change finishes', () => {
    identities.recordChange('/v/a.md', statsOf(10))
    const releaseOlder = identities.changeRan('/v/a.md')
    identities.recordChange('/v/a.md', statsOf(11))
    releaseOlder()
    vi.advanceTimersByTime(CHANGE_KEY_GRACE_MS * 5)
    expect(identities.take('/v/a.md')).toBe(buildFileIdentityKey(statsOf(11)))
  })

  it('a change without an identity drops the older key', () => {
    identities.recordWrite('/v/a.md', statsOf(10))
    identities.recordChange('/v/a.md', statsOf(10, 0))
    expect(identities.take('/v/a.md')).toBeNull()
  })
})
