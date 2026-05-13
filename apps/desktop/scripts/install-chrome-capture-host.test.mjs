import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const scriptPath = join(scriptDir, 'install-chrome-capture-host.mjs')

function expectedPendingDir(homeDir) {
  if (process.platform === 'darwin') {
    return join(
      homeDir,
      'Library',
      'Application Support',
      'memry-dev-dev',
      'capture-inbox',
      'pending'
    )
  }

  if (process.platform === 'win32') {
    return join(homeDir, 'AppData', 'Roaming', 'memry-dev-dev', 'capture-inbox', 'pending')
  }

  return join(homeDir, '.config', 'memry-dev-dev', 'capture-inbox', 'pending')
}

test('device option targets the matching Memry dev userData capture directory', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'memry-capture-install-home-'))
  const manifestDir = mkdtempSync(join(tmpdir(), 'memry-capture-install-manifest-'))

  try {
    execFileSync(
      process.execPath,
      [
        scriptPath,
        '--extension-id',
        'testextensionid',
        '--browser',
        'dia',
        '--manifest-dir',
        manifestDir,
        '--device',
        'dev'
      ],
      {
        cwd: appDir,
        env: { ...process.env, HOME: homeDir }
      }
    )

    const manifest = JSON.parse(readFileSync(join(manifestDir, 'com.memry.capture.json'), 'utf8'))
    const wrapper = readFileSync(manifest.path, 'utf8')

    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://testextensionid/'])
    assert.equal(
      wrapper.includes(`export MEMRY_CAPTURE_DIR='${expectedPendingDir(homeDir)}'`),
      true
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(manifestDir, { recursive: true, force: true })
  }
})

test('dia install writes the native host manifest to Dia and Chromium fallback locations', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Dia native messaging paths are macOS-only')
    return
  }

  const homeDir = mkdtempSync(join(tmpdir(), 'memry-capture-install-home-'))

  try {
    execFileSync(
      process.execPath,
      [scriptPath, '--extension-id', 'testextensionid', '--browser', 'dia', '--device', 'dev'],
      {
        cwd: appDir,
        env: { ...process.env, HOME: homeDir }
      }
    )

    const supportRoot = join(homeDir, 'Library', 'Application Support')
    const manifestPaths = [
      join(supportRoot, 'Dia', 'User Data', 'NativeMessagingHosts', 'com.memry.capture.json'),
      join(supportRoot, 'Google', 'Chrome', 'NativeMessagingHosts', 'com.memry.capture.json'),
      join(supportRoot, 'Chromium', 'NativeMessagingHosts', 'com.memry.capture.json')
    ]

    for (const manifestPath of manifestPaths) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.deepEqual(manifest.allowed_origins, ['chrome-extension://testextensionid/'])
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
