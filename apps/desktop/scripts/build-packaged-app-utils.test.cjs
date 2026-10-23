const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertProductionSyncServerUrl,
  resolveTargetArch
} = require('./build-packaged-app-utils.cjs')

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

test('assertProductionSyncServerUrl accepts the production sync host', () => {
  assert.doesNotThrow(() => assertProductionSyncServerUrl('https://sync.memrynote.com'))
})

test('assertProductionSyncServerUrl rejects missing, local, and staging sync hosts', () => {
  for (const url of [
    '',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://sync.memrynote.com'
  ]) {
    assert.throws(() => assertProductionSyncServerUrl(url), /production SYNC_SERVER_URL/)
  }

  assert.throws(
    () => assertProductionSyncServerUrl('https://sync-staging.memrynote.com'),
    /production SYNC_SERVER_URL/
  )
})
