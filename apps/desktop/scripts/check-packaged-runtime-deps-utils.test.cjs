const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  findPackagedMacApps,
  inferExpectedMacArch,
  normalizeMachOArch,
  archListIncludes
} = require('./check-packaged-runtime-deps-utils.cjs')

test('findPackagedMacApps returns every packaged mac app under dist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-packaged-apps-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'dist', 'mac', 'Memrynote.app'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'dist', 'mac-arm64', 'Memrynote.app'), { recursive: true })

    assert.deepEqual(findPackagedMacApps(tempDir, 'Memrynote', 'x64'), [
      path.join(tempDir, 'dist', 'mac', 'Memrynote.app'),
      path.join(tempDir, 'dist', 'mac-arm64', 'Memrynote.app')
    ])
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }
})

test('inferExpectedMacArch maps mac-arm64 and plain mac bundles', () => {
  assert.equal(
    inferExpectedMacArch('/repo/apps/desktop/dist/mac-arm64/Memrynote.app', 'x64'),
    'arm64'
  )
  assert.equal(inferExpectedMacArch('/repo/apps/desktop/dist/mac/Memrynote.app', 'x64'), 'x64')
})

test('archListIncludes normalizes x86_64 to x64 before matching', () => {
  assert.equal(normalizeMachOArch('x86_64'), 'x64')
  assert.equal(archListIncludes(['x86_64'], 'x64'), true)
  assert.equal(archListIncludes(['x86_64'], 'arm64'), false)
})
