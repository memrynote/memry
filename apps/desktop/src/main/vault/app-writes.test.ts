import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appWriteCheck,
  appWriteCount,
  fileHoldsAppWrite,
  recordAppMove,
  recordAppWrite,
  resetAppWrites
} from './app-writes'

describe('app writes (#5605)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-app-writes-'))
    file = path.join(dir, 'note.md')
  })

  afterEach(() => {
    resetAppWrites()
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function appWrites(bytes: string): void {
    const landed = recordAppWrite(file, bytes)
    fs.writeFileSync(file, bytes)
    landed()
  }

  it('drops the echo of a write and takes any other bytes as an edit', async () => {
    appWrites('# A\n')
    expect(await fileHoldsAppWrite(file)).toBe(true)

    fs.writeFileSync(file, '# A\n\nOutside.\n')
    expect(await fileHoldsAppWrite(file)).toBe(false)
  })

  it('owns the bytes still in the file while the next write is in flight', async () => {
    appWrites('# A\n')
    const landed = recordAppWrite(file, '# B\n')
    expect(await fileHoldsAppWrite(file)).toBe(true)

    fs.writeFileSync(file, '# B\n')
    expect(await fileHoldsAppWrite(file)).toBe(true)
    landed()

    // Bytes the app replaced, put back by someone else, are an edit.
    fs.writeFileSync(file, '# A\n')
    expect(await fileHoldsAppWrite(file)).toBe(false)
  })

  it('takes the app bytes put back after an outside edit as an edit too', async () => {
    appWrites('# A\n')
    fs.writeFileSync(file, '# Outside\n')
    expect(await fileHoldsAppWrite(file)).toBe(false)

    fs.writeFileSync(file, '# A\n')
    expect(await fileHoldsAppWrite(file)).toBe(false)
  })

  it("keeps a write that lands during a read of other bytes as the app's", async () => {
    appWrites('# A\n')
    const landed = recordAppWrite(file, '# B\n')
    const check = appWriteCheck(file)

    fs.writeFileSync(file, '# B\n')
    landed()
    expect(check?.('# Outside\n')).toBe(false)

    expect(await fileHoldsAppWrite(file)).toBe(true)
  })

  it('owns any bytes a hash-less move put there until the record expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fs.writeFileSync(file, 'binary')
    recordAppMove(file)
    expect(await fileHoldsAppWrite(file)).toBe(true)

    vi.setSystemTime(Date.now() + 6000)
    expect(await fileHoldsAppWrite(file)).toBe(false)
  })

  it('evicts expired records from the write path, with no watcher read in between', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    recordAppWrite(path.join(dir, 'old.md'), 'old')()

    vi.setSystemTime(Date.now() + 6000)
    recordAppWrite(path.join(dir, 'new.md'), 'new')()

    expect(appWriteCount()).toBe(1)
  })
})
