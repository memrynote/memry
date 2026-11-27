import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { checkPayload, MANIFEST, manifestDrift } from './assert-payload.mjs'
import { mergePatch, PLATFORMS, readReleaseConfig } from './tauri-config.mjs'

const LINKS = {
  windows: 'kernel32.dll\nntdll.dll',
  macos: '/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)',
  linux: 'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0000)'
}

/** A payload dir holding every file the manifest lists for `platform`, plus `extra`. */
function payload(platform, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'assert-payload-'))
  const entry = MANIFEST.platforms[platform]
  const files = {
    ...Object.fromEntries(entry.executables.map((n) => [path.posix.join(entry.binDir, n), 'exe'])),
    ...Object.fromEntries(
      entry.resources.map((r) => [path.posix.join(entry.resourceDir, r), 'data'])
    ),
    ...extra
  }
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), body)
  }
  return root
}

const check = (platform, root, overrides = {}) =>
  checkPayload({
    platform,
    root,
    config: readReleaseConfig(platform),
    links: () => LINKS[platform],
    ...overrides
  }).errors

describe('checkPayload', () => {
  for (const platform of PLATFORMS) {
    it(`passes a complete ${platform} payload`, () => {
      assert.deepEqual(check(platform, payload(platform)), [])
    })
  }

  it('fails a payload with a shared ONNX Runtime library', () => {
    const errors = check('linux', payload('linux', { 'usr/lib/libonnxruntime.so.1.31.0': 'so' }))
    assert.match(errors.join('\n'), /usr\/lib\/libonnxruntime\.so\.1\.31\.0 is a shared ONNX/)
    const dll = check('windows', payload('windows', { 'onnxruntime.dll': 'dll' }))
    assert.match(dll.join('\n'), /onnxruntime\.dll is a shared ONNX/)
  })

  it('fails a payload with a shared Tesseract or Leptonica library', () => {
    const errors = check(
      'macos',
      payload('macos', {
        'Contents/Frameworks/libtesseract.5.dylib': 'x',
        'Contents/Frameworks/libleptonica.dylib': 'x'
      })
    )
    assert.equal(errors.length, 2)
  })

  it('fails a payload with a model file', () => {
    const errors = check(
      'windows',
      payload('windows', { 'models/ggml-small.bin': 'm', 'model_q4.onnx': 'm' })
    )
    assert.match(errors.join('\n'), /ggml-small\.bin is a model file/)
    assert.match(errors.join('\n'), /model_q4\.onnx is a model file/)
  })

  it('fails a payload without memry-ml-worker', () => {
    const errors = check('macos', payload('macos', { 'Contents/MacOS/memry-ml-worker': null }))
    assert.deepEqual(errors, ['missing Contents/MacOS/memry-ml-worker'])
  })

  it('fails a payload without the English OCR data', () => {
    const root = payload('linux', { 'usr/lib/MemryNote/tessdata/eng.traineddata.gz': null })
    assert.deepEqual(check('linux', root), [
      'missing usr/lib/MemryNote/tessdata/eng.traineddata.gz'
    ])
  })

  it('fails an executable in the binary dir that the manifest does not list', () => {
    const elf = Buffer.from('7f454c4602', 'hex')
    const machO = Buffer.from('cffaedfe07', 'hex')
    assert.deepEqual(check('linux', payload('linux', { 'usr/bin/export-bindings': elf })), [
      'usr/bin/export-bindings is an executable the manifest does not list'
    ])
    assert.deepEqual(
      check('macos', payload('macos', { 'Contents/MacOS/export-bindings': machO })),
      ['Contents/MacOS/export-bindings is an executable the manifest does not list']
    )
    assert.deepEqual(check('windows', payload('windows', { 'export-bindings.exe': 'MZ' })), [
      'export-bindings.exe is an executable the manifest does not list'
    ])
  })

  it('accepts a script in the binary dir and a binary outside it', () => {
    const root = payload('linux', {
      'usr/bin/xdg-open': '#!/bin/sh\n',
      'usr/lib/MemryNote/pdfium/libextra.so': Buffer.from('7f454c46', 'hex')
    })
    assert.deepEqual(check('linux', root), [])
  })

  it('fails a file over the size cap', () => {
    const manifest = { ...MANIFEST, maxFileBytes: 4 }
    const errors = check('windows', payload('windows', { 'big.bin': '12345' }), { manifest })
    assert.deepEqual(errors, ['big.bin is 5 bytes, over the cap of 4'])
  })

  it('fails an executable that links a shared ONNX Runtime or Tesseract library', () => {
    const links = (_platform, file) =>
      file.endsWith('memry-ml-worker')
        ? `${LINKS.linux}\nlibtesseract.so.5 => /usr/lib/libtesseract.so.5 (0x0000)`
        : LINKS.linux
    const errors = check('linux', payload('linux'), { links })
    assert.deepEqual(errors, [
      'usr/bin/memry-ml-worker links libtesseract.so.5 => /usr/lib/libtesseract.so.5 (0x0000)'
    ])
    const ort = check('macos', payload('macos'), {
      links: () =>
        `${LINKS.macos}\n@rpath/libonnxruntime.1.31.0.dylib (compatibility version 0.0.0)`
    })
    assert.equal(ort.length, MANIFEST.platforms.macos.executables.length)
  })

  it('fails a Windows executable that needs the VC++ redistributable', () => {
    const errors = check('windows', payload('windows'), {
      links: () => `${LINKS.windows}\nVCRUNTIME140.dll`
    })
    assert.match(errors.join('\n'), /Memrynote\.exe needs the VC\+\+ redistributable/)
  })

  it('fails an empty link listing', () => {
    const errors = check('windows', payload('windows'), { links: () => '' })
    assert.deepEqual(errors, [
      'Memrynote.exe: the link listing names no system C library',
      'memry-ml-worker.exe: the link listing names no system C library'
    ])
  })
})

describe('manifestDrift', () => {
  for (const platform of PLATFORMS) {
    it(`finds the ${platform} manifest in step with the release config`, () => {
      assert.deepEqual(manifestDrift(platform, MANIFEST, readReleaseConfig(platform)), [])
    })
  }

  it('fails a sidecar the config bundles and the manifest does not list', () => {
    const config = mergePatch(readReleaseConfig('linux'), {
      bundle: { externalBin: ['binaries/memry-ml-worker', 'binaries/memrynote-cli'] }
    })
    assert.deepEqual(manifestDrift('linux', MANIFEST, config), [
      'linux: the manifest lacks executables memrynote-cli'
    ])
  })

  it('fails a sidecar the manifest lists and the config does not bundle', () => {
    const config = mergePatch(readReleaseConfig('windows'), { bundle: { externalBin: [] } })
    assert.deepEqual(manifestDrift('windows', MANIFEST, config), [
      'windows: the config bundles no executables memry-ml-worker.exe'
    ])
  })

  it('fails a resource the config bundles and the manifest does not list', () => {
    const config = mergePatch(readReleaseConfig('macos'), {
      bundle: { resources: { 'resources/webview2/': 'webview2/' } }
    })
    assert.deepEqual(manifestDrift('macos', MANIFEST, config), [
      'macos: the manifest lists no file of the bundled resource webview2'
    ])
  })

  it('fails a resource the manifest lists and the config does not bundle', () => {
    const config = mergePatch(readReleaseConfig('linux'), {
      bundle: { resources: { 'resources/tessdata/eng.traineddata.gz': null } }
    })
    assert.deepEqual(manifestDrift('linux', MANIFEST, config), [
      'linux: the config bundles no resource tessdata/eng.traineddata.gz'
    ])
  })
})

describe('readReleaseConfig', () => {
  it('merges the platform file and the release overlay over the base config', () => {
    const config = readReleaseConfig('macos')
    assert.equal(config.mainBinaryName, 'MemryNote')
    assert.equal(config.bundle.active, true)
    assert.equal(config.bundle.macOS.minimumSystemVersion, '13.0')
  })

  it('bundles the worker on every platform and the EventKit helper beside it on macOS only', () => {
    assert.deepEqual(readReleaseConfig('macos').bundle.externalBin, [
      'binaries/memry-ml-worker',
      '../eventkit/bin/memry-eventkit'
    ])
    for (const platform of ['windows', 'linux']) {
      assert.deepEqual(readReleaseConfig(platform).bundle.externalBin, ['binaries/memry-ml-worker'])
    }
  })

  it('lists the EventKit helper in the macOS payload manifest', () => {
    assert.ok(MANIFEST.platforms.macos.executables.includes('memry-eventkit'))
  })

  it('passes the macOS overlay to the rehearsal workflow macOS build, as the config the checks read', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../.github/workflows/update-bridge-rehearsal.yml'),
      'utf8'
    )
    const macBuild = workflow
      .split('\n')
      .filter((line) => line.includes('tauri build') && line.includes('--bundles app '))
    assert.equal(macBuild.length, 1)
    assert.match(
      macBuild[0],
      /--config src-tauri\/tauri\.release\.conf\.json --config src-tauri\/tauri\.release\.macos\.conf\.json /
    )
  })

  it('applies RFC 7396: null deletes, arrays and scalars replace', () => {
    assert.deepEqual(mergePatch({ a: { b: 1, c: [1] }, d: 1 }, { a: { b: null, c: [2] }, d: 2 }), {
      a: { c: [2] },
      d: 2
    })
  })
})
