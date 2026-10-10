import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewImageSource } from '../../../../image-processing/protocol'
import { AgentToolError } from '../../errors'
import { viewVaultFile, type FileViewDeps } from '../file-view'

// The seam: right after the tool's vault check resolves the image, it is
// swapped for a link to a file outside the vault, before anything reads it.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    if (race.target !== '' && probe === race.target) {
      race.target = ''
      race.swap()
    }
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})

const isWindows = process.platform === 'win32'

describe('vault_view_file against an image swapped for an outside link (#3098)', () => {
  let vault: string
  let outside: string
  let seen: string[]

  const deps = (): FileViewDeps => ({
    vaultPath: vault,
    fileRow: () => ({ id: 'shot', path: 'Screens/login.png', title: 'login', fileType: 'image' }),
    prepareImage: async (source: ViewImageSource) => {
      // Whatever the image worker would decode: the bytes it was handed, or the file it opens.
      const bytes = source.data
      seen.push(Buffer.from(bytes).toString('utf8'))
      return {
        data: new Uint8Array([1]),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        sourceWidth: 1,
        sourceHeight: 1
      }
    },
    openPdf: async () => {
      throw new Error('no pdf')
    }
  })

  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-view-swap-vault-')))
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-view-swap-outside-')))
    seen = []
    fs.mkdirSync(path.join(vault, 'Screens'))
  })

  afterEach(() => {
    race.target = ''
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('hands the image worker the vault bytes it checked', async () => {
    fs.writeFileSync(path.join(vault, 'Screens/login.png'), 'vault image')

    await viewVaultFile(deps(), { id: 'shot' })

    expect(seen).toEqual(['vault image'])
  })

  it.skipIf(isWindows)('never hands over a file swapped outside after the check', async () => {
    const file = path.join(vault, 'Screens/login.png')
    const secret = path.join(outside, 'private.png')
    fs.writeFileSync(file, 'vault image')
    fs.writeFileSync(secret, 'outside secret')
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }

    const error = await viewVaultFile(deps(), { id: 'shot' }).then(
      () => null,
      (caught: unknown) => caught
    )

    expect(race.target).toBe('')
    expect(seen.join('')).not.toContain('outside secret')
    expect(error).toBeInstanceOf(AgentToolError)
    expect((error as AgentToolError).code).toBe('PERMISSION_DENIED')
  })
})
