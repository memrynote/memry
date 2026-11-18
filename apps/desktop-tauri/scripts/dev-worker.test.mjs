import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasLibclang, segmentPattern, workerBuild, workerFeatures } from './dev-worker.mjs'

describe('workerFeatures', () => {
  it('builds the whole worker, transcription included, where ONNX Runtime links and cmake runs', () => {
    const native = ['--features', 'native']
    assert.deepEqual(
      workerFeatures({ platform: 'darwin', arch: 'arm64', env: {}, cmake: true, libclang: true }),
      native
    )
    assert.deepEqual(
      workerFeatures({
        platform: 'linux',
        arch: 'x64',
        env: { ORT_LIB_LOCATION: '/ort' },
        cmake: true,
        libclang: true
      }),
      native
    )
  })

  it('leaves the embedding model and transcription out without ORT_LIB_LOCATION', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['win32', 'x64'],
      ['darwin', 'x64']
    ]) {
      assert.deepEqual(workerFeatures({ platform, arch, env: {}, cmake: true, libclang: true }), [
        '--no-default-features',
        '--features',
        'pdf,ocr'
      ])
    }
  })

  it('leaves OCR and transcription out without cmake', () => {
    assert.deepEqual(
      workerFeatures({ platform: 'darwin', arch: 'arm64', env: {}, cmake: false, libclang: true }),
      ['--no-default-features', '--features', 'pdf,embed']
    )
    assert.deepEqual(
      workerFeatures({ platform: 'win32', arch: 'x64', env: {}, cmake: false, libclang: true }),
      ['--no-default-features', '--features', 'pdf']
    )
  })

  it('leaves transcription out without libclang, which bindgen needs', () => {
    assert.deepEqual(
      workerFeatures({ platform: 'darwin', arch: 'arm64', env: {}, cmake: true, libclang: false }),
      ['--no-default-features', '--features', 'pdf,ocr,embed']
    )
  })
})

describe('hasLibclang', () => {
  const none = () => undefined

  it('searches only LIBCLANG_PATH when it is set, as clang-sys does', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-libclang-'))
    assert.equal(
      hasLibclang({ platform: 'darwin', env: { LIBCLANG_PATH: empty }, llvmPrefix: none }),
      false
    )
    const llvm = mkdtempSync(join(tmpdir(), 'libclang-'))
    writeFileSync(join(llvm, 'libclang.dylib'), '')
    assert.equal(
      hasLibclang({ platform: 'darwin', env: { LIBCLANG_PATH: llvm }, llvmPrefix: none }),
      true
    )
    const file = join(llvm, 'libclang.dylib')
    assert.equal(
      hasLibclang({ platform: 'darwin', env: { LIBCLANG_PATH: file }, llvmPrefix: none }),
      true
    )
  })

  it('finds a versioned Linux libclang under llvm-config --prefix', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'llvm-prefix-'))
    mkdirSync(join(prefix, 'lib'))
    writeFileSync(join(prefix, 'lib', 'libclang.so.18'), '')
    assert.equal(hasLibclang({ platform: 'linux', env: {}, llvmPrefix: () => prefix }), true)
  })
})

describe('segmentPattern', () => {
  it('matches regex special characters literally and `*` as the only wildcard', () => {
    const pattern = segmentPattern('C:\\Program Files (x86).[a]*')
    assert.equal(pattern.test('C:\\Program Files (x86).[a]'), true)
    assert.equal(pattern.test('c:\\program files (x86).[A]-18'), true)
    assert.equal(pattern.test('C:\\Program Files x86.[a]'), false)
    assert.equal(pattern.test('C:\\Program Files (x86)X[a]'), false)
    assert.equal(pattern.test('C:\\Program Files (x86).a'), false)
    assert.equal(pattern.test('C:Program Files (x86).[a]'), false)
  })
})

describe('workerBuild', () => {
  it('runs cargo from crates/ so its .cargo/config.toml applies', () => {
    const crates = resolve(fileURLToPath(new URL('../../../crates', import.meta.url)))
    const build = workerBuild(['--features', 'native'])
    assert.equal(build.cwd, crates)
    assert.deepEqual(build.args, [
      'build',
      '-p',
      'memry-ml-worker',
      '--bin',
      'memry-ml-worker',
      '--features',
      'native'
    ])
  })
})
