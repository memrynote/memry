import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam: after a note file is opened and before the opened file is checked,
// a save renames a new file over it, as the atomic write in vault/file-ops does.
const race = vi.hoisted(() => ({ target: '', calls: 0, swap: (): void => {} }))

function swapOnRecheck(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.calls++
  if (race.calls !== 2) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    swapOnRecheck(probe)
    return actual.realpath(probe)
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    swapOnRecheck(probe)
    return actual.realpathSync.native(probe)
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

import { openVaultFileSync, readVaultFile } from './paths'

describe('a note file saved over while it is opened', () => {
  let vault: string

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-replace-vault-')))
    const note = path.join(vault, 'a.md')
    fs.writeFileSync(note, 'old\n')
    race.calls = 0
    race.target = note
    race.swap = () => {
      fs.writeFileSync(`${note}.tmp`, 'new\n')
      fs.renameSync(`${note}.tmp`, note)
    }
  })

  afterEach(() => {
    race.target = ''
    fs.rmSync(vault, { recursive: true, force: true })
  })

  it('is read, not refused as outside the vault', async () => {
    await expect(readVaultFile(vault, 'a.md')).resolves.toBe('new\n')
  })

  it('is read by the sync opener too', () => {
    const fd = openVaultFileSync(vault, 'a.md')
    expect(fd).not.toBeNull()
    try {
      expect(fs.readFileSync(fd as number, 'utf-8')).toBe('new\n')
    } finally {
      fs.closeSync(fd as number)
    }
  })
})
