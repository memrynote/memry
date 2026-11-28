import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  BRIDGES_WIN_LINUX,
  buildBridgeFeeds,
  buildLatestLinuxYml,
  buildLatestMacYml,
  buildLatestYml,
  describeBytes,
  setupExeName,
  writeBridgeFeeds
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
    assert.deepEqual(
      validateManifest(parseManifest(text), { requireMinimumSystemVersion: true }).errors,
      []
    )
  })

  // Shipped .deb installs update only through latest-linux.yml, so the deb is listed; the AppImage
  // stays first because `path` names the file AppImage installs download.
  it('writes latest-linux.yml with the AppImage first and the deb second', () => {
    const text = buildLatestLinuxYml({
      version: v,
      releaseDate,
      appImage: entry(`MemryNote-${v}-x86_64.AppImage`, 'E', 500),
      deb: entry(`MemryNote-${v}-amd64.deb`, 'G', 700)
    })
    assert.equal(
      text,
      [
        'version: 2099.101.1',
        'files:',
        '  - url: MemryNote-2099.101.1-x86_64.AppImage',
        `    sha512: ${'E'.repeat(86)}==`,
        '    size: 500',
        '  - url: MemryNote-2099.101.1-amd64.deb',
        `    sha512: ${'G'.repeat(86)}==`,
        '    size: 700',
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
    assert.throws(() => buildLatestLinuxYml({ version: v, releaseDate }), /AppImage/)
    assert.throws(
      () =>
        buildLatestLinuxYml({
          version: v,
          releaseDate: '2099-01-01',
          appImage: entry('a', 'A', 1)
        }),
      /releaseDate/
    )
    assert.throws(
      () => buildLatestMacYml({ version: v, releaseDate, arm64Zip: entry('a', 'A', 1) }),
      /x64 zip/
    )
  })

  const mac = {
    arm64Zip: entry(`MemryNote-${v}-arm64.zip`, 'A', 100),
    x64Zip: entry(`MemryNote-${v}-x64.zip`, 'C', 300)
  }
  const linux = { appImage: entry(`MemryNote-${v}-x86_64.AppImage`, 'E', 500) }
  const setup = entry(setupExeName(v), 'F', 600)

  it('writes all three feeds while the Windows and Linux bridge is on', () => {
    assert.equal(BRIDGES_WIN_LINUX, true)
    const feeds = buildBridgeFeeds({ version: v, releaseDate, mac, linux, setup })
    assert.deepEqual(Object.keys(feeds), ['latest-mac.yml', 'latest-linux.yml', 'latest.yml'])
    assert.equal(feeds['latest.yml'], buildLatestYml({ version: v, releaseDate, setup }))
  })

  // macOS Electron installs reach Tauri only through latest-mac.yml; no flag turns it off.
  it('always writes latest-mac.yml and refuses to omit it', () => {
    const feeds = buildBridgeFeeds({ version: v, releaseDate, mac, bridgesWinLinux: false })
    assert.deepEqual(Object.keys(feeds), ['latest-mac.yml'])
    assert.throws(
      () => buildBridgeFeeds({ version: v, releaseDate, linux, setup }),
      /latest-mac.yml is always published/
    )
  })

  it('leaves out latest.yml when no Windows setup was built', () => {
    const feeds = buildBridgeFeeds({ version: v, releaseDate, mac, linux })
    assert.deepEqual(Object.keys(feeds), ['latest-mac.yml', 'latest-linux.yml'])
  })

  it('adds stagingPercentage only when given, and only 1 to 100', () => {
    const plain = buildBridgeFeeds({ version: v, releaseDate, mac, linux, setup })
    for (const text of Object.values(plain)) assert.doesNotMatch(text, /stagingPercentage/)
    const staged = buildBridgeFeeds({
      version: v,
      releaseDate,
      mac,
      linux,
      setup,
      stagingPercentage: 10
    })
    for (const text of Object.values(staged)) assert.match(text, /\nstagingPercentage: 10\n$/)
    assert.deepEqual(
      validateManifest(parseManifest(staged['latest-mac.yml']), {
        requireMinimumSystemVersion: true
      }).errors,
      []
    )
    for (const bad of [0, 101, 12.5, '10']) {
      assert.throws(
        () => buildBridgeFeeds({ version: v, releaseDate, mac, stagingPercentage: bad }),
        /stagingPercentage/
      )
    }
  })
})

describe('writeBridgeFeeds', () => {
  const ciFiles = [
    `MemryNote-${v}-arm64.zip`,
    `MemryNote-${v}-arm64.dmg`,
    `MemryNote-${v}-x64.zip`,
    `MemryNote-${v}-x64.dmg`,
    `MemryNote-${v}-x86_64.AppImage`,
    `MemryNote-${v}-amd64.deb`
  ]

  function inTemp(files, fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridge-feeds-'))
    try {
      for (const name of files) writeFileSync(path.join(dir, name), `bytes of ${name}`)
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const hash = (name) => createHash('sha512').update(`bytes of ${name}`).digest('base64')

  it('writes latest-mac.yml and latest-linux.yml from the staged CI files', () =>
    inTemp(ciFiles, (dir) => {
      assert.deepEqual(writeBridgeFeeds(dir, { version: v, releaseDate }), [
        'latest-mac.yml',
        'latest-linux.yml'
      ])
      const mac = parseManifest(readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'))
      assert.deepEqual(
        mac.files.map((file) => [file.url, file.sha512]),
        [ciFiles[0], ciFiles[1], ciFiles[2], ciFiles[3]].map((name) => [name, hash(name)])
      )
      assert.deepEqual(validateManifest(mac, { requireMinimumSystemVersion: true }).errors, [])
      const linux = readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8')
      assert.match(linux, new RegExp(`^path: MemryNote-${v}-x86_64\\.AppImage$`, 'm'))
      assert.ok(linux.includes(`url: MemryNote-${v}-amd64.deb`))
      assert.ok(!readdirSync(dir).includes('latest.yml'))
    }))

  it('adds latest.yml once the setup copy is staged', () =>
    inTemp([...ciFiles, setupExeName(v)], (dir) => {
      assert.ok(writeBridgeFeeds(dir, { version: v, releaseDate }).includes('latest.yml'))
      assert.match(readFileSync(path.join(dir, 'latest.yml'), 'utf8'), /setup\.exe/)
    }))

  it('fails on a missing file instead of writing a feed without it', () =>
    inTemp(
      ciFiles.filter((name) => !name.endsWith('.deb')),
      (dir) => {
        assert.throws(
          () => writeBridgeFeeds(dir, { version: v, releaseDate }),
          /ENOENT.*amd64\.deb/
        )
        assert.deepEqual(
          readdirSync(dir).filter((name) => name.endsWith('.yml')),
          []
        )
      }
    ))
})
