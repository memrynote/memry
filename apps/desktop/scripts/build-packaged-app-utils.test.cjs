const assert = require('node:assert/strict')
const test = require('node:test')

const { resolveTargetArch } = require('./build-packaged-app-utils.cjs')

test('resolveTargetArch uses the explicit electron-builder arch flag', () => {
  assert.equal(resolveTargetArch(['--mac', '--arm64', '--publish', 'never'], 'x64'), 'arm64')
  assert.equal(resolveTargetArch(['--mac', '--x64', '--publish', 'never'], 'arm64'), 'x64')
})

test('resolveTargetArch rejects multiple mac architectures in one staged package', () => {
  assert.throws(
    () => resolveTargetArch(['--mac', '--x64', '--arm64'], 'x64'),
    /one mac architecture/
  )
})

test('resolveTargetArch falls back to the host arch when no arch flag is present', () => {
  assert.equal(resolveTargetArch(['--dir'], 'arm64'), 'arm64')
})
