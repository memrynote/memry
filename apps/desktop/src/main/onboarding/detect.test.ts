import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readObsidianVaults } from './detect'

describe('readObsidianVaults', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("lists Obsidian's registered vaults that still exist on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), 'obsidian-registry-'))
    const work = join(dir, 'Work')
    mkdirSync(work)
    const config = join(dir, 'obsidian.json')
    writeFileSync(
      config,
      JSON.stringify({
        vaults: {
          a1: { path: work, ts: 1, open: true },
          b2: { path: join(dir, 'Deleted'), ts: 2 }
        }
      })
    )

    expect(await readObsidianVaults(config)).toEqual([{ name: 'Work', path: work }])
  })

  it('treats a missing or corrupt registry as no vaults', async () => {
    dir = mkdtempSync(join(tmpdir(), 'obsidian-registry-'))
    const config = join(dir, 'obsidian.json')
    expect(await readObsidianVaults(config)).toEqual([])
    writeFileSync(config, '{not json')
    expect(await readObsidianVaults(config)).toEqual([])
  })
})
