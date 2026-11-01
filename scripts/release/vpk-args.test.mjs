import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  RETIRED_SETUP_NAME,
  TARGETS,
  assertPublishable,
  assetNames,
  buildPackArgs
} from './vpk-args.mjs'
import { renameToPublished } from './vpk-pack.mjs'

const base = { version: '2099.101.1', packDir: 'pack', outputDir: 'out' }
const common = (os, exe, runtime, channel) => [
  `[${os}]`,
  'pack',
  '--packId',
  'MemryNote',
  '--packTitle',
  'MemryNote',
  '--packAuthors',
  'memrynote',
  '--packVersion',
  '2099.101.1',
  '--packDir',
  'pack',
  '--mainExe',
  exe,
  '--runtime',
  runtime,
  '--channel',
  channel,
  '--outputDir',
  'out'
]

describe('buildPackArgs', () => {
  it('packs Windows x64 on the production channel with the first-pack delta mode', () => {
    assert.deepEqual(
      buildPackArgs('win-x64', {
        ...base,
        delta: 'None',
        iconPath: 'icon.ico',
        signTemplate: 'sign {{file}}'
      }),
      [
        ...common('win', 'Memrynote.exe', 'win-x64', 'win'),
        '--delta',
        'None',
        '--icon',
        'icon.ico',
        '--framework',
        'webview2',
        '--noPortable',
        '--signTemplate',
        'sign {{file}}'
      ]
    )
  })

  it('packs Windows arm64 on its own channel with the arm64 runtime dependency', () => {
    assert.deepEqual(buildPackArgs('win-arm64', { ...base, iconPath: 'icon.ico' }), [
      ...common('win', 'Memrynote.exe', 'win-arm64', 'win-arm64'),
      '--delta',
      'BestSpeed',
      '--icon',
      'icon.ico',
      '--framework',
      'webview2',
      '--noPortable'
    ])
  })

  for (const arch of ['arm64', 'x64']) {
    it(`packs macOS ${arch} signed, notarized, with deep signing off`, () => {
      assert.deepEqual(
        buildPackArgs(`osx-${arch}`, {
          ...base,
          delta: 'BestSize',
          identity: 'Developer ID Application: X',
          entitlements: 'ent.plist',
          notaryProfile: 'memry-notary',
          keychain: 'kc'
        }),
        [
          ...common('osx', 'MemryNote', `osx-${arch}`, `osx-${arch}`),
          '--delta',
          'BestSize',
          '--noInst',
          '--signAppIdentity',
          'Developer ID Application: X',
          '--signEntitlements',
          'ent.plist',
          '--signDisableDeep',
          '--notaryProfile',
          'memry-notary',
          '--keychain',
          'kc'
        ]
      )
    })
  }

  it('packs Linux x64 on the linux channel', () => {
    assert.deepEqual(buildPackArgs('linux-x64', base), [
      ...common('linux', 'memrynote', 'linux-x64', 'linux'),
      '--delta',
      'BestSpeed'
    ])
  })

  it('rejects unknown targets, bad delta modes and missing signing inputs', () => {
    assert.throws(() => buildPackArgs('freebsd', base), /Unknown pack target/)
    assert.throws(() => buildPackArgs('linux-x64', { ...base, delta: 'Fast' }), /delta/)
    assert.throws(() => buildPackArgs('osx-arm64', base), /identity is required/)
    assert.throws(() => buildPackArgs('win-x64', base), /iconPath is required/)
  })
})

describe('assetNames', () => {
  const v = '2099.101.1'

  // Electron builds v2026-09-12 to v2026-10-25 HEAD vpk's x64 Setup name and, on a 200, arm a
  // hand-off that hangs, so they never update. No release may carry that name again.
  it("never publishes the Setup under vpk's x64 name", () => {
    for (const name of Object.keys(TARGETS)) {
      assert.ok(!Object.values(assetNames(name, v)).includes(RETIRED_SETUP_NAME), name)
    }
    const out = mkdtempSync(path.join(tmpdir(), 'vpk-out-'))
    try {
      for (const file of [RETIRED_SETUP_NAME, `MemryNote-${v}-full.nupkg`, 'releases.win.json']) {
        writeFileSync(path.join(out, file), '')
      }
      const index = path.join(out, 'assets.win.json')
      writeFileSync(
        index,
        JSON.stringify([
          { RelativeFileName: RETIRED_SETUP_NAME, Type: 'Installer' },
          { RelativeFileName: `MemryNote-${v}-full.nupkg`, Type: 'Full' }
        ])
      )
      renameToPublished(out)
      assert.deepEqual(readdirSync(out).toSorted(), [
        'MemryNote-2099.101.1-full.nupkg',
        'MemryNote-Setup-win-x64.exe',
        'assets.win.json',
        'releases.win.json'
      ])
      assert.deepEqual(
        JSON.parse(readFileSync(index, 'utf8')).map((entry) => entry.RelativeFileName),
        ['MemryNote-Setup-win-x64.exe', `MemryNote-${v}-full.nupkg`]
      )
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
    assert.throws(() => assertPublishable(['releases.win.json', RETIRED_SETUP_NAME]), /never/)
    assert.doesNotThrow(() => assertPublishable(['MemryNote-Setup-win-x64.exe']))
  })

  it('keeps the production Windows x64 names, with the Setup renamed', () => {
    assert.deepEqual(assetNames('win-x64', v), {
      setup: 'MemryNote-Setup-win-x64.exe',
      full: `MemryNote-${v}-full.nupkg`,
      delta: `MemryNote-${v}-delta.nupkg`,
      releases: 'releases.win.json',
      legacyReleases: 'RELEASES'
    })
  })

  it('names every other target after its channel', () => {
    assert.deepEqual(assetNames('win-arm64', v), {
      setup: 'MemryNote-win-arm64-Setup.exe',
      full: `MemryNote-${v}-win-arm64-full.nupkg`,
      delta: `MemryNote-${v}-win-arm64-delta.nupkg`,
      releases: 'releases.win-arm64.json',
      legacyReleases: 'RELEASES-win-arm64'
    })
    assert.deepEqual(assetNames('osx-x64', v), {
      full: `MemryNote-${v}-osx-x64-full.nupkg`,
      delta: `MemryNote-${v}-osx-x64-delta.nupkg`,
      releases: 'releases.osx-x64.json',
      legacyReleases: 'RELEASES-osx-x64',
      portable: 'MemryNote-osx-x64-Portable.zip',
      squirrelZip: `MemryNote-${v}-x64.zip`
    })
    assert.deepEqual(assetNames('linux-x64', v), {
      full: `MemryNote-${v}-linux-full.nupkg`,
      delta: `MemryNote-${v}-linux-delta.nupkg`,
      releases: 'releases.linux.json',
      legacyReleases: 'RELEASES-linux',
      portable: 'MemryNote.AppImage',
      appImage: `MemryNote-${v}-x86_64.AppImage`
    })
  })
})

describe('vpk-pack cli', () => {
  it('maps flags to the pack options', async () => {
    const { parsePackCli } = await import('./vpk-pack.mjs')
    const { target, options } = parsePackCli([
      'linux-x64',
      '--version',
      '2099.101.1',
      '--pack-dir',
      'p',
      '--output-dir',
      'o',
      '--delta',
      'None'
    ])
    assert.equal(target, 'linux-x64')
    assert.deepEqual(buildPackArgs(target, options).slice(-2), ['--delta', 'None'])
  })
})
