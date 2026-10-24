import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  buildLatestLinuxYml,
  buildLatestMacYml,
  buildLatestYml,
  describeBytes,
  setupExeName
} from './bridge-feeds.mjs'
import { parseManifest, validateManifest } from '../validate-mac-update-manifest.mjs'

const releaseDate = '2099-01-01T10:00:00.123Z'
const v = '2099.101.1'
const entry = (url, fill, size) => ({ url, sha512: `${fill.repeat(86)}==`, size })

describe('bridge feeds', () => {
  it('writes latest-mac.yml in electron-builder order with minimumSystemVersion last', () => {
    const text = buildLatestMacYml({
      version: v,
      releaseDate,
      arm64Zip: entry(`MemryNote-${v}-arm64.zip`, 'A', 100),
      arm64Dmg: entry(`MemryNote-${v}-arm64.dmg`, 'B', 200),
      x64Zip: entry(`MemryNote-${v}-x64.zip`, 'C', 300),
      x64Dmg: entry(`MemryNote-${v}-x64.dmg`, 'D', 400)
    })
    const sha = (c) => `${c.repeat(86)}==`
    assert.equal(
      text,
      [
        'version: 2099.101.1',
        'files:',
        '  - url: MemryNote-2099.101.1-arm64.zip',
        `    sha512: ${sha('A')}`,
        '    size: 100',
        '  - url: MemryNote-2099.101.1-arm64.dmg',
        `    sha512: ${sha('B')}`,
        '    size: 200',
        '  - url: MemryNote-2099.101.1-x64.zip',
        `    sha512: ${sha('C')}`,
        '    size: 300',
        '  - url: MemryNote-2099.101.1-x64.dmg',
        `    sha512: ${sha('D')}`,
        '    size: 400',
        'path: MemryNote-2099.101.1-arm64.zip',
        `sha512: ${sha('A')}`,
        "releaseDate: '2099-01-01T10:00:00.123Z'",
        'minimumSystemVersion: 22.0.0',
        ''
      ].join('\n')
    )
  })

  it('writes a latest-mac.yml the manifest validator accepts, without dmg entries', () => {
    const text = buildLatestMacYml({
      version: v,
      releaseDate,
      arm64Zip: entry(`MemryNote-${v}-arm64.zip`, 'A', 100),
      x64Zip: entry(`MemryNote-${v}-x64.zip`, 'C', 300)
    })
    assert.deepEqual(validateManifest(parseManifest(text)).errors, [])
  })

  it('writes latest-linux.yml with path and sha512 of the first listed file', () => {
    const text = buildLatestLinuxYml({
      version: v,
      releaseDate,
      files: [entry(`MemryNote-${v}-x86_64.AppImage`, 'E', 500)]
    })
    assert.equal(
      text,
      [
        'version: 2099.101.1',
        'files:',
        '  - url: MemryNote-2099.101.1-x86_64.AppImage',
        `    sha512: ${'E'.repeat(86)}==`,
        '    size: 500',
        'path: MemryNote-2099.101.1-x86_64.AppImage',
        `sha512: ${'E'.repeat(86)}==`,
        "releaseDate: '2099-01-01T10:00:00.123Z'",
        ''
      ].join('\n')
    )
  })

  it('writes latest.yml with the single setup entry', () => {
    const text = buildLatestYml({
      version: v,
      releaseDate,
      setup: entry(setupExeName(v), 'F', 600)
    })
    assert.match(
      text,
      /^version: 2099\.101\.1\nfiles:\n  - url: MemryNote-2099\.101\.1-setup\.exe\n/
    )
    assert.match(
      text,
      /\npath: MemryNote-2099\.101\.1-setup\.exe\nsha512: F{86}==\nreleaseDate: '2099-01-01T10:00:00.123Z'\n$/
    )
    assert.doesNotMatch(text, /blockMapSize|minimumSystemVersion/)
  })

  it('recomputes sha512 and size from the uploaded bytes', () => {
    const bytes = Buffer.from('signed installer bytes')
    const described = describeBytes('a.exe', bytes)
    assert.equal(described.size, bytes.length)
    assert.equal(described.sha512, createHash('sha512').update(bytes).digest('base64'))
  })

  it('rejects incomplete input', () => {
    assert.throws(() => buildLatestLinuxYml({ version: v, releaseDate, files: [] }), /files/)
    assert.throws(
      () =>
        buildLatestLinuxYml({ version: v, releaseDate: '2099-01-01', files: [entry('a', 'A', 1)] }),
      /releaseDate/
    )
    assert.throws(
      () => buildLatestMacYml({ version: v, releaseDate, arm64Zip: entry('a', 'A', 1) }),
      /x64 zip/
    )
  })
})
