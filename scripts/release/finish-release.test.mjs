import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { crc32 } from 'node:zlib'

import { setupExeName, writeBridgeFeeds } from './bridge-feeds.mjs'
import {
  bridgeRelease,
  draftProblems,
  feedProblems,
  isPortableExecutable,
  listPortableExecutables,
  packReleaseAssets,
  releaseSetProblems,
  requiredWindowsBinaries,
  signaturePlan,
  stagePackOutputs,
  unpackPayload,
  uploadVerifiedAssets
} from './finish-release.mjs'
import { ciAssets } from './required-assets.mjs'
import { assetNames } from './vpk-args.mjs'

const V = '2026.1120.1'
const repoRoot = path.resolve(import.meta.dirname, '../..')

const withDir = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'finish-release-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

let counter = 0
const write = (file, bytes = `bytes ${counter++} of ${path.basename(file)}`) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

/**
 * A PE32+ image header: `MZ` with a PE-style relocation offset (file(1) reads `PE32+` only then),
 * e_lfanew 0x80, `PE\0\0`, an x64 COFF header and the optional header magic.
 */
function peBytes() {
  const image = Buffer.alloc(0x200)
  image.write('MZ', 0, 'latin1')
  image.writeUInt16LE(0x40, 0x18)
  image.writeUInt32LE(0x80, 0x3c)
  image.write('PE\0\0', 0x80, 'latin1')
  image.writeUInt16LE(0x8664, 0x84)
  image.writeUInt16LE(0xf0, 0x94)
  image.writeUInt16LE(0x22, 0x96)
  image.writeUInt16LE(0x20b, 0x98)
  image.writeUInt16LE(3, 0x98 + 68)
  return image
}

/** vpk's output dir after `renameToPublished`, holding the previous full the delta used. */
function vpkOutput(dir, target, { delta = true } = {}) {
  const names = assetNames(target, V)
  for (const name of [names.setup, names.full, names.releases, names.legacyReleases]) {
    write(path.join(dir, name))
  }
  if (delta) write(path.join(dir, names.delta))
  write(path.join(dir, names.full.replace(V, '2026.1119.1')))
  write(path.join(dir, `assets.${target === 'win-x64' ? 'win' : target}.json`), '[]')
  write(path.join(dir, `MemryNote-${target}.log`))
}

/** The `memry-release-<V>` artifact: the CI set with the feeds stage-release writes. */
function ciArtifact(dir) {
  for (const name of ciAssets(V).required.filter((n) => !n.endsWith('.yml'))) {
    write(path.join(dir, name))
  }
  writeBridgeFeeds(dir, { version: V, releaseDate: '2026-11-20T10:00:00.000Z' })
}

/** The asset dir after pack-windows and bridge, as pnpm release leaves it before verify. */
function finishedRelease(dir) {
  const assets = path.join(dir, 'assets')
  ciArtifact(assets)
  for (const target of ['win-x64', 'win-arm64']) {
    const out = path.join(dir, `vpk-${target}`)
    vpkOutput(out, target)
    stagePackOutputs(target, V, out, assets)
  }
  bridgeRelease(assets, V)
  return assets
}

describe('Windows pack outputs', () => {
  it("stages only the target's release assets, never the delta base, index or log", () =>
    withDir((dir) => {
      vpkOutput(dir, 'win-x64')
      vpkOutput(dir, 'win-arm64')
      const outputs = readdirSync(dir)

      assert.deepEqual(packReleaseAssets('win-x64', V, outputs), [
        'MemryNote-Setup-win-x64.exe',
        `MemryNote-${V}-full.nupkg`,
        `MemryNote-${V}-delta.nupkg`,
        'releases.win.json',
        'RELEASES'
      ])
      assert.deepEqual(packReleaseAssets('win-arm64', V, outputs), [
        'MemryNote-win-arm64-Setup.exe',
        `MemryNote-${V}-win-arm64-full.nupkg`,
        `MemryNote-${V}-win-arm64-delta.nupkg`,
        'releases.win-arm64.json',
        'RELEASES-win-arm64'
      ])
    }))

  it('stages no delta when the pack had none (first Tauri release)', () =>
    withDir((dir) => {
      vpkOutput(dir, 'win-arm64', { delta: false })

      assert.equal(
        packReleaseAssets('win-arm64', V, readdirSync(dir)).some((n) => n.includes('delta')),
        false
      )
    }))
})

describe('bridge and release set', () => {
  it('leaves exactly the release asset set, with latest.yml naming a copy of the signed x64 Setup', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)

      assert.deepEqual(releaseSetProblems(assets, V), [])
      assert.deepEqual(feedProblems(assets, V), [])
      assert.deepEqual(
        readFileSync(path.join(assets, setupExeName(V))),
        readFileSync(path.join(assets, 'MemryNote-Setup-win-x64.exe'))
      )
      assert.match(
        readFileSync(path.join(assets, 'latest.yml'), 'utf8'),
        new RegExp(`^path: MemryNote-${V.replaceAll('.', '\\.')}-setup\\.exe$`, 'm')
      )
    }))

  it('names each missing and each unexpected file', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      rmSync(path.join(assets, 'RELEASES-win-arm64'))
      write(path.join(assets, 'MemryNote-win-arm64-Portable.zip'))
      write(path.join(assets, 'MemryNote-win-Setup.exe'))

      assert.deepEqual(releaseSetProblems(assets, V), [
        'missing: RELEASES-win-arm64',
        'unexpected: MemryNote-win-Setup.exe',
        'unexpected: MemryNote-win-arm64-Portable.zip'
      ])
    }))
})

describe('feed check', () => {
  // A Setup re-signed after the bridge step changes bytes the feed already describes;
  // electron-updater would refuse the download on every NSIS install.
  it('reports a staged file whose bytes changed after the feed was written', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      write(path.join(assets, setupExeName(V)), 'signed again, longer than before')

      assert.deepEqual(feedProblems(assets, V), [
        `latest.yml: sha512 of ${setupExeName(V)} differs`,
        `latest.yml: size of ${setupExeName(V)} differs`,
        `latest.yml: ${setupExeName(V)} is not a copy of MemryNote-Setup-win-x64.exe`
      ])
    }))

  it('reports a listed file that is not staged and a feed of another version', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      rmSync(path.join(assets, `MemryNote-${V}-amd64.deb`))
      const mac = path.join(assets, 'latest-mac.yml')
      writeFileSync(mac, readFileSync(mac, 'utf8').replace(`version: ${V}`, 'version: 2026.1119.1'))

      assert.deepEqual(feedProblems(assets, V), [
        `latest-linux.yml: MemryNote-${V}-amd64.deb is not staged`,
        `latest-mac.yml: version 2026.1119.1, expected ${V}`
      ])
    }))

  it('reports a latest.yml that lists any file but the Setup copy', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      const feed = path.join(assets, 'latest.yml')
      writeFileSync(
        feed,
        readFileSync(feed, 'utf8').replaceAll(setupExeName(V), 'MemryNote-Setup-win-x64.exe')
      )

      assert.deepEqual(feedProblems(assets, V), [
        `latest.yml: lists MemryNote-Setup-win-x64.exe, expected only ${setupExeName(V)}`
      ])
    }))

  it('reports a Setup copy whose bytes are not the signed x64 Setup', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      write(path.join(assets, setupExeName(V)), 'a Setup of another build')
      writeBridgeFeeds(assets, { version: V })

      assert.deepEqual(feedProblems(assets, V), [
        `latest.yml: ${setupExeName(V)} is not a copy of MemryNote-Setup-win-x64.exe`
      ])
    }))

  it('reports top-level path and sha512 that do not name the first file', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      const linux = path.join(assets, 'latest-linux.yml')
      writeFileSync(
        linux,
        readFileSync(linux, 'utf8').replace(/^path: .*$/m, `path: MemryNote-${V}-amd64.deb`)
      )

      assert.deepEqual(feedProblems(assets, V), [
        `latest-linux.yml: path and sha512 do not name MemryNote-${V}-x86_64.AppImage`
      ])
    }))
})

/**
 * A stored (uncompressed) zip. `madeBy` is the host byte of "version made by": 0 is what .NET's
 * ZipArchive, which `Compress-Archive` uses, writes on Windows; 3 is Unix. Entries ending in a
 * separator are directories. An entry's optional `mode` sets Unix file type and permissions.
 */
function zipOf(entries, { madeBy }) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content = '', { mode } = {}] of entries) {
    const nameBytes = Buffer.from(name, 'latin1')
    const data = Buffer.from(content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((madeBy << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(
      mode === undefined ? (/[\\/]$/.test(name) ? 0x10 : 0x20) : (mode << 16) >>> 0,
      38
    )
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

describe('payload unpack', () => {
  const payload = (sep) => [
    ['Memrynote.exe', 'exe'],
    ['memry-ml-worker.exe', 'worker'],
    [`pdfium${sep}`],
    [`pdfium${sep}pdfium.dll`, 'dll'],
    [`tessdata${sep}eng.traineddata.gz`, 'eng']
  ]
  const unpacked = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
      .toSorted()
  const expected = [
    'Memrynote.exe',
    'memry-ml-worker.exe',
    path.join('pdfium', 'pdfium.dll'),
    path.join('tessdata', 'eng.traineddata.gz')
  ]

  for (const [label, sep, madeBy] of [
    ['forward slashes', '/', 0],
    ['backslashes from a Windows host', '\\', 0]
  ]) {
    it(`unpacks a Compress-Archive zip with ${label} into its directories`, () =>
      withDir((dir) => {
        const bytes = zipOf(payload(sep), { madeBy })
        const zip = path.join(dir, 'payload.zip')
        writeFileSync(zip, bytes)
        const pack = path.join(dir, 'pack')
        mkdirSync(pack)

        unpackPayload(zip, pack, sha256(bytes))

        assert.deepEqual(unpacked(pack), expected)
        assert.equal(readFileSync(path.join(pack, 'pdfium', 'pdfium.dll'), 'utf8'), 'dll')
      }))
  }

  it('refuses a zip whose backslash names stay flat', () =>
    withDir((dir) => {
      const bytes = zipOf(payload('\\'), { madeBy: 3 })
      const zip = path.join(dir, 'payload.zip')
      writeFileSync(zip, bytes)
      const pack = path.join(dir, 'pack')
      mkdirSync(pack)

      assert.throws(
        () => unpackPayload(zip, pack, sha256(bytes)),
        /payload\.zip unpacked to names holding a backslash: .*pdfium\\pdfium\.dll/
      )
    }))

  for (const [label, name, madeBy] of [
    ['a parent segment', '../escape.txt', 3],
    ['a nested parent segment', 'pdfium/../../escape.txt', 3],
    ['a backslash parent segment', 'pdfium\\..\\..\\escape.txt', 0],
    ['an absolute path', '/tmp/escape.txt', 3],
    ['a backslash root', '\\escape.txt', 0],
    ['a drive letter', 'C:/escape.txt', 0]
  ]) {
    it(`refuses an entry with ${label} before unpacking anything`, () =>
      withDir((dir) => {
        const bytes = zipOf([...payload('/'), [name, 'outside']], { madeBy })
        const zip = path.join(dir, 'payload.zip')
        writeFileSync(zip, bytes)
        const pack = path.join(dir, 'pack')
        mkdirSync(pack)

        assert.throws(
          () => unpackPayload(zip, pack, sha256(bytes)),
          (error) => error.message === `payload.zip holds entries outside the pack dir: ${name}`
        )
        assert.deepEqual(readdirSync(pack), [])
      }))
  }

  it('refuses a zip that unpacks a symbolic link', () =>
    withDir((dir) => {
      const modes = payload('/').map(([name, content]) => [
        name,
        content,
        { mode: name.endsWith('/') ? 0o40755 : 0o100644 }
      ])
      const bytes = zipOf([...modes, ['pdfium/link.dll', '/etc/hosts', { mode: 0o120777 }]], {
        madeBy: 3
      })
      const zip = path.join(dir, 'payload.zip')
      writeFileSync(zip, bytes)
      const pack = path.join(dir, 'pack')
      mkdirSync(pack)

      assert.throws(
        () => unpackPayload(zip, pack, sha256(bytes)),
        /payload\.zip unpacked to symbolic links: pdfium\/link\.dll$/
      )
    }))

  it('refuses a zip other than the one the build checked, before unpacking it', () =>
    withDir((dir) => {
      const bytes = zipOf(payload('/'), { madeBy: 0 })
      const zip = path.join(dir, 'payload.zip')
      writeFileSync(zip, bytes)
      const pack = path.join(dir, 'pack')
      mkdirSync(pack)

      assert.throws(
        () => unpackPayload(zip, pack, 'c'.repeat(64)),
        new RegExp(
          `payload\\.zip has sha256 ${sha256(bytes)}; release-metadata\\.json records c{64}`
        )
      )
      assert.deepEqual(readdirSync(pack), [])
    }))
})

describe('PE files and signers', () => {
  it('recognizes a PE image by its MZ header and PE signature', () => {
    assert.equal(isPortableExecutable(peBytes()), true)
    const mzOnly = peBytes()
    mzOnly.write('XX', 0x80, 'latin1')
    assert.equal(isPortableExecutable(mzOnly), false)
    assert.equal(isPortableExecutable(Buffer.from('\x7fELF\x02\x01\x01')), false)
    assert.equal(isPortableExecutable(Buffer.from('MZ')), false)
    const pastEnd = peBytes()
    pastEnd.writeUInt32LE(0x1fe, 0x3c)
    assert.equal(isPortableExecutable(pastEnd), false)
  })

  it('lists the PE files under an app dir, nested ones included', () =>
    withDir((dir) => {
      for (const file of [
        'Memrynote.exe',
        'pdfium/pdfium.dll',
        'webview2/MicrosoftEdgeWebview2Setup.exe'
      ]) {
        write(path.join(dir, file), peBytes())
      }
      write(path.join(dir, 'pdfium/LICENSE'))
      write(path.join(dir, 'tessdata/eng.traineddata.gz'))

      assert.deepEqual(listPortableExecutables(dir), [
        'Memrynote.exe',
        'pdfium/pdfium.dll',
        'webview2/MicrosoftEdgeWebview2Setup.exe'
      ])
    }))

  it('finds a PE file whose header sits past the first 4 KiB', () =>
    withDir((dir) => {
      const image = Buffer.alloc(0x2100)
      image.write('MZ', 0, 'latin1')
      image.writeUInt32LE(0x2000, 0x3c)
      image.write('PE\0\0', 0x2000, 'latin1')
      write(path.join(dir, 'late-header.dll'), image)

      assert.deepEqual(listPortableExecutables(dir), ['late-header.dll'])
    }))

  it('refuses an MZ file without a PE signature, which the sign script would skip', () =>
    withDir((dir) => {
      const dos = peBytes()
      dos.write('XX', 0x80, 'latin1')
      write(path.join(dir, 'tools/legacy.com'), dos)

      assert.throws(
        () => listPortableExecutables(dir),
        /start with MZ but hold no PE signature: tools\/legacy\.com$/
      )
    }))

  it('refuses an archive no signature check opens, except the allow-listed OCR data', () =>
    withDir((dir) => {
      write(path.join(dir, 'Memrynote.exe'), peBytes())
      write(path.join(dir, 'tessdata/eng.traineddata.gz'), Buffer.from([0x1f, 0x8b, 8, 0]))
      assert.deepEqual(listPortableExecutables(dir), ['Memrynote.exe'])

      write(path.join(dir, 'resources/bundle.dat'), zipOf([['inner.exe', 'MZ']], { madeBy: 3 }))
      write(path.join(dir, 'resources/data.gz'), Buffer.from([0x1f, 0x8b, 8, 0]))
      assert.throws(
        () => listPortableExecutables(dir),
        /holds archives no signature check opens: resources\/bundle\.dat, resources\/data\.gz$/
      )
    }))

  it('requires the payload manifest binaries and the WebView2 bootstrapper', () => {
    assert.deepEqual(requiredWindowsBinaries(), [
      'Memrynote.exe',
      'memry-ml-worker.exe',
      'pdfium/pdfium.dll',
      'webview2/MicrosoftEdgeWebview2Setup.exe'
    ])
  })

  it('checks ours against Certum and the bootstrapper against Microsoft', () => {
    const files = [
      'Memrynote.exe',
      'memry-ml-worker.exe',
      'memrynote-cli.exe',
      'pdfium/pdfium.dll',
      'webview2/MicrosoftEdgeWebview2Setup.exe'
    ]

    assert.deepEqual(signaturePlan(files), [
      { file: 'Memrynote.exe', signer: 'certum' },
      { file: 'memry-ml-worker.exe', signer: 'certum' },
      { file: 'memrynote-cli.exe', signer: 'certum' },
      { file: 'pdfium/pdfium.dll', signer: 'certum' },
      { file: 'webview2/MicrosoftEdgeWebview2Setup.exe', signer: 'Microsoft Corporation' }
    ])
  })

  it('checks a near-name of a third-party file against Certum', () => {
    assert.deepEqual(
      signaturePlan(
        ['webview2/xMicrosoftEdgeWebview2Setup.exe', 'webview2/MicrosoftEdgeWebview2Setup.exe.exe'],
        { required: [] }
      ),
      [
        { file: 'webview2/xMicrosoftEdgeWebview2Setup.exe', signer: 'certum' },
        { file: 'webview2/MicrosoftEdgeWebview2Setup.exe.exe', signer: 'certum' }
      ]
    )
  })

  it('refuses a pack without a required binary', () => {
    const files = requiredWindowsBinaries().filter((file) => file !== 'memry-ml-worker.exe')

    assert.throws(() => signaturePlan(files), /The pack holds no memry-ml-worker\.exe/)
  })

  it('refuses a third-party signer it has no check for', () => {
    assert.throws(
      () =>
        signaturePlan(['Memrynote.exe', 'vendor.dll'], {
          required: [],
          thirdParty: [{ name: 'vendor.dll', signer: 'Vendor Inc' }]
        }),
      /No signature check for vendor\.dll, signed by Vendor Inc/
    )
  })
})

/**
 * A gh that holds the draft's assets the way GitHub lists them: `release upload` replaces by name
 * and records GitHub's sha256 digest, and `DELETE releases/assets/<id>` removes one.
 */
function fakeGh(initial = []) {
  const draft = new Map(initial.map((asset) => [asset.name, asset]))
  const calls = []
  let nextId = 1000
  return {
    calls,
    draft,
    json(args) {
      calls.push(args)
      assert.deepEqual(args, [
        'api',
        '--paginate',
        '--slurp',
        'repos/o/r/releases/99/assets?per_page=100'
      ])
      return [[...draft.values()]]
    },
    run(args) {
      calls.push(args)
      if (args[0] === 'api' && args[2] === 'DELETE') {
        const id = Number(args[3].split('/').at(-1))
        for (const [name, asset] of draft) if (asset.id === id) draft.delete(name)
        return
      }
      assert.deepEqual(args.slice(0, 3), ['release', 'upload', 'vnext'])
      for (const file of args.filter((arg) => path.isAbsolute(arg))) {
        const bytes = readFileSync(file)
        draft.set(path.basename(file), remoteAsset(path.basename(file), bytes, nextId++))
      }
    }
  }
}

const remoteAsset = (name, bytes, id) => ({
  digest: `sha256:${sha256(bytes)}`,
  id,
  name,
  size: bytes.length
})
const draftOf = (assets) =>
  readdirSync(assets).map((name, id) =>
    remoteAsset(name, readFileSync(path.join(assets, name)), id + 1)
  )
const target = { draftTag: 'vnext', releaseId: '99', repo: 'o/r' }

describe('draft upload and publish check', () => {
  it('deletes draft assets outside the verified set before it uploads, and then matches', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      const gh = fakeGh([
        remoteAsset('MemryNote-win-Setup.exe', Buffer.from('retired'), 1),
        remoteAsset('MemryNote-2026.1119.1-amd64.deb', Buffer.from('old'), 2),
        remoteAsset('latest.yml', Buffer.from('old feed'), 3)
      ])

      uploadVerifiedAssets({ assetDir: assets, gh, ...target })

      const deletes = gh.calls.filter((args) => args[2] === 'DELETE').map((args) => args[3])
      assert.deepEqual(deletes, ['repos/o/r/releases/assets/1', 'repos/o/r/releases/assets/2'])
      assert.equal(gh.calls.at(-1)[1], 'upload')
      assert.deepEqual(draftProblems({ assetDir: assets, gh, ...target }), [])
    }))

  it('names each missing, unexpected, resized and changed asset on the draft', () =>
    withDir((dir) => {
      const assets = finishedRelease(dir)
      const remote = draftOf(assets)
      const byName = (name) => remote.find((asset) => asset.name === name)
      remote.splice(remote.indexOf(byName('RELEASES')), 1)
      remote.push(remoteAsset('MemryNote-2026.1119.1-amd64.deb', Buffer.from('old'), 900))
      byName('latest.yml').size += 1
      byName('latest-mac.yml').digest = `sha256:${'0'.repeat(64)}`
      byName('releases.win.json').digest = null

      assert.deepEqual(draftProblems({ assetDir: assets, gh: fakeGh(remote), ...target }), [
        'missing on the draft: RELEASES',
        'latest-mac.yml: sha256 on the draft differs from the verified file',
        `latest.yml: size ${byName('latest.yml').size} on the draft, ${byName('latest.yml').size - 1} verified`,
        'releases.win.json: the draft lists no sha256 digest',
        'unexpected on the draft: MemryNote-2026.1119.1-amd64.deb'
      ])
    }))
})

describe('sign-windows-binary.sh', { skip: !hasFile() && 'needs file(1)' }, () => {
  it('signs our PE files and never the third-party-signed ones', () =>
    withDir((dir) => {
      const bin = path.join(dir, 'bin')
      const calls = path.join(dir, 'calls')
      write(path.join(bin, 'jsign'), `#!/bin/sh\necho "$@" >> "${calls}"\n`)
      chmodSync(path.join(bin, 'jsign'), 0o755)
      const sign = (file) =>
        spawnSync('sh', [path.join(repoRoot, 'scripts/sign-windows-binary.sh'), file], {
          encoding: 'utf8',
          env: { ...process.env, MEMRY_SIGN_PIN: 'x', PATH: `${bin}:${process.env.PATH}` }
        })

      const listed = JSON.parse(
        readFileSync(path.join(repoRoot, 'scripts/release/third-party-signed.json'), 'utf8')
      )
      for (const { name } of listed) {
        const file = path.join(dir, 'webview2', name)
        write(file, peBytes())
        const result = sign(file)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /skip third-party-signed/)
      }
      const ours = ['memry-ml-worker.exe', ...listed.map(({ name }) => `x${name}`)]
      for (const name of ours) {
        write(path.join(dir, name), peBytes())
        assert.equal(sign(path.join(dir, name)).status, 0)
      }

      const signed = readFileSync(calls, 'utf8').trim().split('\n')
      assert.deepEqual(
        signed.map((line) => path.basename(line.split(' ').at(-1))),
        ours
      )
    }))
})

function hasFile() {
  return spawnSync('file', ['--version'], { stdio: 'ignore' }).status === 0
}
