const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const builderRequire = createRequire(
  createRequire(require.resolve('electron-builder')).resolve('app-builder-lib')
)
const { load } = builderRequire('js-yaml')
const { LinuxPackager } = builderRequire('./index.js')

const {
  assertProductionSyncServerUrl,
  resolveTargetArch
} = require('./build-packaged-app-utils.cjs')

test('AppImage desktop launch preserves sandboxing and deep-link arguments', async () => {
  const config = load(
    fs.readFileSync(path.join(__dirname, '../config/electron-builder.yml'), 'utf8')
  )
  const packager = new LinuxPackager({
    config,
    metadata: require('../package.json'),
    buildResourcesDir: path.join(__dirname, '../build')
  })
  let appImage
  packager.createTargets(['appimage'], (_name, factory) => {
    appImage = factory(os.tmpdir())
  })

  const desktopEntry = await appImage.desktopEntry.value
  assert.match(desktopEntry, /^Exec=AppRun %U$/m)
  assert.match(desktopEntry, /^MimeType=.*x-scheme-handler\/memry;/m)
})

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
