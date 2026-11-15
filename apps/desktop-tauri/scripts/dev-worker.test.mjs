import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { workerFeatures } from './dev-worker.mjs'

describe('workerFeatures', () => {
  it('builds the whole worker where ONNX Runtime links', () => {
    const native = ['--features', 'native']
    assert.deepEqual(workerFeatures({ platform: 'darwin', arch: 'arm64', env: {} }), native)
    assert.deepEqual(
      workerFeatures({ platform: 'linux', arch: 'x64', env: { ORT_LIB_LOCATION: '/ort' } }),
      native
    )
  })

  it('leaves the embedding model out without ORT_LIB_LOCATION', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['win32', 'x64'],
      ['darwin', 'x64']
    ]) {
      assert.deepEqual(workerFeatures({ platform, arch, env: {} }), [
        '--no-default-features',
        '--features',
        'pdf'
      ])
    }
  })
})
