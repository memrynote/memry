// check-glibc.sh, repack-deb.sh, make-dmg.sh and sign-macos-bundle.sh against the real tools where the host has them,
// with stubs only for what needs Apple credentials (codesign, notarytool, stapler).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

const here = import.meta.dirname
const has = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0

function inTemp(fn) {
  // The real path: macOS make-dmg.sh prints $PWD, which resolves /var to /private/var.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'release-sh-')))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function stub(binDir, name, body) {
  mkdirSync(binDir, { recursive: true })
  writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(path.join(binDir, name), 0o755)
}

const run = (script, args, { cwd, binDir } = {}) =>
  spawnSync(path.join(here, script), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(binDir && { PATH: `${binDir}:${process.env.PATH}` }) }
  })

describe('check-glibc.sh', () => {
  // objdump is stubbed to print the dynamic symbol table kept beside each fake ELF file, so the
  // version rule runs on any host. The real tool runs in the release job and the PR's container proof.
  function payload(dir, files) {
    const root = path.join(dir, 'AppDir')
    for (const [name, versions] of Object.entries(files)) {
      const file = path.join(root, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF payload')]))
      const table = versions.map((v) => `0000 DF *UND* 0000 (${v}) sym`).join('\n')
      writeFileSync(`${file}.symbols`, `${table}\n`)
    }
    stub(path.join(dir, 'bin'), 'objdump', 'cat "$2.symbols"')
    return root
  }

  it('passes when nothing needs more than GLIBC_2.35', () =>
    inTemp((dir) => {
      const root = payload(dir, {
        'usr/bin/memrynote': ['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_PRIVATE'],
        'usr/lib/libpdfium.so': ['GLIBC_2.35', 'GLIBC_2.17']
      })
      const result = run('check-glibc.sh', [root], { binDir: path.join(dir, 'bin') })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /newest: GLIBC_2\.35 across 2 ELF files/)
    }))

  it('names each file that needs a newer glibc', () =>
    inTemp((dir) => {
      const root = payload(dir, {
        'usr/bin/memrynote': ['GLIBC_2.34'],
        'usr/bin/memry-ml-worker': ['GLIBC_2.38', 'GLIBC_2.4'],
        'usr/lib/libx.so': ['GLIBC_2.35.1']
      })
      const result = run('check-glibc.sh', [root], { binDir: path.join(dir, 'bin') })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /memry-ml-worker needs GLIBC_2\.38, newer than GLIBC_2\.35/)
      assert.match(result.stderr, /libx\.so needs GLIBC_2\.35\.1/)
      assert.doesNotMatch(result.stderr, /memrynote needs/)
    }))

  it('fails when there is no ELF file to check', () =>
    inTemp((dir) => {
      mkdirSync(path.join(dir, 'empty'))
      writeFileSync(path.join(dir, 'empty', 'readme'), 'text')
      const result = run('check-glibc.sh', [path.join(dir, 'empty')])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no ELF file/)
    }))
})

describe('repack-deb.sh', { skip: !has('dpkg-deb') && 'needs dpkg-deb' }, () => {
  it('renames the package, sets Depends and Homepage, and keeps the payload', () =>
    inTemp((dir) => {
      const root = path.join(dir, 'root')
      mkdirSync(path.join(root, 'DEBIAN'), { recursive: true })
      mkdirSync(path.join(root, 'usr/bin'), { recursive: true })
      writeFileSync(path.join(root, 'usr/bin/memrynote'), '#!/bin/sh\n')
      chmodSync(path.join(root, 'usr/bin/memrynote'), 0o755)
      // The control file tauri-bundler 2 writes.
      writeFileSync(
        path.join(root, 'DEBIAN/control'),
        [
          'Package: memry-note',
          'Version: 2026.1101.1',
          'Architecture: amd64',
          'Installed-Size: 1',
          'Maintainer: memrynote',
          'Priority: optional',
          'Depends: libwebkit2gtk-4.1-0,',
          ' libgtk-3-0',
          'Description: MemryNote',
          ' A local-first notes app.',
          ''
        ].join('\n')
      )
      const tauriDeb = path.join(dir, 'tauri.deb')
      assert.equal(spawnSync('dpkg-deb', ['-b', root, tauriDeb]).status, 0)
      const out = path.join(dir, 'MemryNote-2026.1101.1-amd64.deb')
      const result = run('repack-deb.sh', [tauriDeb, out])
      assert.equal(result.status, 0, result.stderr)
      const field = (name) =>
        spawnSync('dpkg-deb', ['-f', out, name], { encoding: 'utf8' }).stdout.trim()
      assert.equal(field('Package'), 'memrynote')
      assert.equal(field('Version'), '2026.1101.1')
      assert.equal(
        field('Depends'),
        'libwebkit2gtk-4.1-0, libgtk-3-0, libsoup-3.0-0, libayatana-appindicator3-1, libsecret-1-0, libenchant-2-2, xdg-utils'
      )
      assert.equal(field('Homepage'), 'https://github.com/memrynote/memry')
      assert.equal(field('Description'), 'MemryNote\n A local-first notes app.')
      const listing = spawnSync('dpkg-deb', ['-c', out], { encoding: 'utf8' }).stdout
      assert.match(listing, /-rwxr-xr-x root\/root .* \.\/usr\/bin\/memrynote/)
    }))
})

describe('make-dmg.sh', { skip: process.platform !== 'darwin' && 'needs hdiutil' }, () => {
  it('builds the dmg with the app and an Applications link, then signs, notarizes and staples', () =>
    inTemp((dir) => {
      const app = path.join(dir, 'in', 'MemryNote.app')
      mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
      writeFileSync(path.join(app, 'Contents/MacOS/MemryNote'), 'bin')
      const bin = path.join(dir, 'bin')
      const calls = path.join(dir, 'calls')
      stub(bin, 'codesign', `echo "codesign $*" >> "${calls}"`)
      stub(bin, 'xcrun', `echo "xcrun $*" >> "${calls}"`)
      const result = run('make-dmg.sh', [app, 'arm64', '2026.1101.1', 'Developer ID', 'kc'], {
        cwd: dir,
        binDir: bin
      })
      assert.equal(result.status, 0, result.stderr)
      const dmg = path.join(dir, 'MemryNote-2026.1101.1-arm64.dmg')
      assert.equal(result.stdout.trim().split('\n').at(-1), dmg)
      assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
        `codesign --force --timestamp --keychain kc --sign Developer ID ${dmg}`,
        `xcrun notarytool submit ${dmg} --wait --keychain-profile memry-notary --keychain kc`,
        `xcrun stapler staple ${dmg}`,
        `xcrun stapler validate ${dmg}`
      ])
      const mount = path.join(dir, 'mnt')
      const attach = ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]
      assert.equal(spawnSync('hdiutil', attach).status, 0)
      try {
        assert.ok(existsSync(path.join(mount, 'MemryNote.app/Contents/MacOS/MemryNote')))
        assert.ok(lstatSync(path.join(mount, 'Applications')).isSymbolicLink())
        assert.equal(readlinkSync(path.join(mount, 'Applications')), '/Applications')
      } finally {
        spawnSync('hdiutil', ['detach', mount, '-force'])
      }
    }))

  it('refuses an unknown arch', () =>
    inTemp((dir) => {
      mkdirSync(path.join(dir, 'A.app'))
      const result = run('make-dmg.sh', [path.join(dir, 'A.app'), 'universal', '1.0.0', 'id'])
      assert.equal(result.status, 2)
    }))
})

describe(
  'sign-macos-bundle.sh',
  { skip: process.platform !== 'darwin' && 'needs PlistBuddy' },
  () => {
    it('gives the app entitlements to the main binary and the bundle only', () =>
      inTemp((dir) => {
        const app = path.join(dir, 'MemryNote.app')
        const files = {
          'Contents/Info.plist':
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
            '<key>CFBundleExecutable</key><string>MemryNote</string></dict></plist>',
          'Contents/MacOS/MemryNote': 'bin',
          'Contents/MacOS/memry-ml-worker': 'bin',
          'Contents/Resources/pdfium/libpdfium.dylib': 'lib'
        }
        for (const [rel, body] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(app, rel)), { recursive: true })
          writeFileSync(path.join(app, rel), body)
        }
        const bin = path.join(dir, 'bin')
        const calls = path.join(dir, 'calls')
        stub(bin, 'codesign', `echo "codesign $*" >> "${calls}"`)
        const result = run('sign-macos-bundle.sh', [app, 'Developer ID', 'app.plist', 'kc'], {
          binDir: bin
        })
        assert.equal(result.status, 0, result.stderr)
        const signing = '--force --timestamp --options runtime'
        assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
          `codesign ${signing} --keychain kc --sign Developer ID ${app}/Contents/MacOS/memry-ml-worker`,
          `codesign ${signing} --keychain kc --sign Developer ID ${app}/Contents/Resources/pdfium/libpdfium.dylib`,
          `codesign ${signing} --entitlements app.plist --keychain kc --sign Developer ID ${app}/Contents/MacOS/MemryNote`,
          `codesign ${signing} --entitlements app.plist --keychain kc --sign Developer ID ${app}`,
          `codesign --verify --strict --verbose=2 ${app}`
        ])
      }))
  }
)
