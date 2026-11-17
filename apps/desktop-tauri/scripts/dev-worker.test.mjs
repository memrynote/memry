import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { workerBuild, workerFeatures } from './dev-worker.mjs'

describe('workerFeatures', () => {
  it('builds the whole worker, transcription included, where ONNX Runtime links and cmake runs', () => {
    const native = ['--features', 'native']
    assert.deepEqual(
      workerFeatures({ platform: 'darwin', arch: 'arm64', env: {}, cmake: true }),
      native
    )
    assert.deepEqual(
      workerFeatures({
        platform: 'linux',
        arch: 'x64',
        env: { ORT_LIB_LOCATION: '/ort' },
        cmake: true
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
      assert.deepEqual(workerFeatures({ platform, arch, env: {}, cmake: true }), [
        '--no-default-features',
        '--features',
        'pdf,ocr'
      ])
    }
  })

  it('leaves OCR and transcription out without cmake', () => {
    assert.deepEqual(workerFeatures({ platform: 'darwin', arch: 'arm64', env: {}, cmake: false }), [
      '--no-default-features',
      '--features',
      'pdf,embed'
    ])
    assert.deepEqual(workerFeatures({ platform: 'win32', arch: 'x64', env: {}, cmake: false }), [
      '--no-default-features',
      '--features',
      'pdf'
    ])
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
