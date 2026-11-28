/**
 * chokidar reads a folder before its watch starts, and on macOS the watch
 * starts later still, so a file written in between reports nothing. The
 * locked-attachments watch reads each new folder again once its watch had
 * time to start.
 *
 * @module vault-locks/attachment-watch.test
 */

import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { protectLockedFile } from './files'
import { watchLockedAttachments } from './attachment-watch'

// A watch that reports the folders it finds and none of their files.
const watches = vi.hoisted(() => [] as Array<EventEmitter & { close(): Promise<void> }>)
vi.mock('chokidar', () => ({
  watch: () => {
    const watch = Object.assign(new EventEmitter(), { close: async () => {} })
    watches.push(watch)
    return watch
  }
}))
vi.mock('./files', () => ({ protectLockedFile: vi.fn() }))

describe('the locked attachments watch', () => {
  let root: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(protectLockedFile).mockClear()
    root = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'memry-attachment-watch-')),
      'attachments'
    )
  })

  afterEach(async () => {
    await watchLockedAttachments(null)
    watches.length = 0
    vi.useRealTimers()
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  })

  const protectedFiles = () => vi.mocked(protectLockedFile).mock.calls.map(([filePath]) => filePath)

  const write = (relativePath: string): string => {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'bytes')
    return filePath
  }

  it('protects the files of each folder its watch reported nothing in', async () => {
    await watchLockedAttachments(root)
    const watch = watches[0]
    const noteFile = write('note-a/photo.png')
    const nested = write('note-a/sub/deep.png')
    write('note-a/.DS_Store')
    const laterFile = write('note-b/scan.pdf')

    watch.emit('addDir', root)
    watch.emit('addDir', path.join(root, 'note-b'))
    // A folder removed before its read again.
    watch.emit('addDir', path.join(root, 'gone'))
    await vi.advanceTimersByTimeAsync(2000)

    await vi.waitFor(() =>
      expect(protectedFiles()).toEqual(expect.arrayContaining([noteFile, laterFile]))
    )
    expect(protectedFiles()).not.toContain(nested)
    expect(protectedFiles().some((filePath) => filePath.endsWith('.DS_Store'))).toBe(false)
  })

  it('reads nothing again once the lock is gone', async () => {
    await watchLockedAttachments(root)
    const photo = write('note-a/photo.png')
    watches[0].emit('addDir', path.join(root, 'note-a'))

    await watchLockedAttachments(null)
    await vi.advanceTimersByTimeAsync(2000)
    // Time for a read the closed watch should not have started.
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(protectedFiles()).not.toContain(photo)
  })
})
