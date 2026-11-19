import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { RETIRED_SETUP_NAME } from './vpk-args.mjs'
import { checkAssetSet, ciAssets, releaseAssets } from './required-assets.mjs'

const v = '2026.1101.1'
const script = path.join(import.meta.dirname, 'required-assets.mjs')

// The release asset table of #3556, with the x64 Setup under its #3702 name. Landing
// `/api/download`, the cask and every shipped updater read these names.
const CI_REQUIRED = [
  'MemryNote-2026.1101.1-arm64.dmg',
  'MemryNote-2026.1101.1-arm64.zip',
  'MemryNote-2026.1101.1-osx-arm64-full.nupkg',
  'releases.osx-arm64.json',
  'RELEASES-osx-arm64',
  'MemryNote-2026.1101.1-x64.dmg',
  'MemryNote-2026.1101.1-x64.zip',
  'MemryNote-2026.1101.1-osx-x64-full.nupkg',
  'releases.osx-x64.json',
  'RELEASES-osx-x64',
  'MemryNote-2026.1101.1-x86_64.AppImage',
  'MemryNote-2026.1101.1-amd64.deb',
  'MemryNote-2026.1101.1-linux-full.nupkg',
  'releases.linux.json',
  'RELEASES-linux',
  'latest-mac.yml',
  'latest-linux.yml'
]
const CI_DELTAS = [
  'MemryNote-2026.1101.1-osx-arm64-delta.nupkg',
  'MemryNote-2026.1101.1-osx-x64-delta.nupkg',
  'MemryNote-2026.1101.1-linux-delta.nupkg'
]
const WINDOWS_REQUIRED = [
  'MemryNote-Setup-win-x64.exe',
  'MemryNote-2026.1101.1-full.nupkg',
  'releases.win.json',
  'RELEASES',
  'MemryNote-win-arm64-Setup.exe',
  'MemryNote-2026.1101.1-win-arm64-full.nupkg',
  'releases.win-arm64.json',
  'RELEASES-win-arm64',
  'MemryNote-2026.1101.1-setup.exe',
  'latest.yml'
]

function staged(names) {
  const dir = mkdtempSync(path.join(tmpdir(), 'assets-'))
  for (const name of names) writeFileSync(path.join(dir, name), '')
  return dir
}

const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

describe('required assets', () => {
  it('pins the CI asset set', () => {
    assert.deepEqual(ciAssets(v), { required: CI_REQUIRED, optional: CI_DELTAS })
  })

  it('pins the release asset set: CI plus both Windows packs and the bridge feed', () => {
    const { required, optional } = releaseAssets(v)
    assert.deepEqual(required, [...CI_REQUIRED, ...WINDOWS_REQUIRED])
    assert.deepEqual(optional, [
      ...CI_DELTAS,
      'MemryNote-2026.1101.1-delta.nupkg',
      'MemryNote-2026.1101.1-win-arm64-delta.nupkg'
    ])
  })

  it('drops latest-linux.yml, latest.yml and the setup copy when the bridge is off', () => {
    const { required } = releaseAssets(v, { bridgesWinLinux: false })
    for (const name of ['latest-linux.yml', 'latest.yml', 'MemryNote-2026.1101.1-setup.exe']) {
      assert.ok(!required.includes(name), name)
    }
    assert.ok(required.includes('latest-mac.yml'))
  })

  it('names missing and unexpected files', () => {
    const names = [
      ...CI_REQUIRED.filter((name) => !name.endsWith('.deb')),
      'MemryNote-osx-arm64-Portable.zip',
      'MemryNote.AppImage',
      RETIRED_SETUP_NAME,
      'assets.linux.json'
    ]
    assert.deepEqual(checkAssetSet(names, ciAssets(v)), {
      missing: ['MemryNote-2026.1101.1-amd64.deb'],
      unexpected: [
        'MemryNote-osx-arm64-Portable.zip',
        'MemryNote.AppImage',
        RETIRED_SETUP_NAME,
        'assets.linux.json'
      ]
    })
  })

  // The landing `linux` matcher takes the first asset ending `.AppImage`, so vpk's unversioned
  // portable AppImage must never be uploaded beside the versioned one.
  it("rejects vpk's unversioned MemryNote.AppImage", () => {
    const dir = staged([...CI_REQUIRED, 'MemryNote.AppImage'])
    try {
      const result = cli(dir, '--version', v)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /^unexpected: MemryNote\.AppImage$/m)
      assert.doesNotMatch(result.stderr, /missing:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--list prints the staged set one per line, deltas included', () => {
    const dir = staged([...CI_REQUIRED, CI_DELTAS[2]])
    try {
      const result = cli(dir, '--version', v, '--list')
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(
        result.stdout.trimEnd().split('\n'),
        [...CI_REQUIRED, CI_DELTAS[2]].toSorted()
      )
      assert.equal(cli(dir, '--version', v).stdout, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 1 on a staged set that is not the release set', () => {
    const dir = staged([...CI_REQUIRED, 'MemryNote-2026.1101.1-x64.dmg.blockmap'])
    try {
      const result = cli(dir, '--version', v, '--set', 'release', '--list')
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /missing: MemryNote-Setup-win-x64\.exe/)
      assert.match(result.stderr, /unexpected: MemryNote-2026\.1101\.1-x64\.dmg\.blockmap/)
      assert.match(cli(dir).stderr, /usage/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
