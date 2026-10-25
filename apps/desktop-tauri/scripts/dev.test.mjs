import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildLaunch, DEBUG_PORT, parseEnvFile } from './dev.mjs'

describe('parseEnvFile', () => {
  it('reads keys, quotes, comments and export', () => {
    assert.deepEqual(
      parseEnvFile(
        `# comment\nA=1\nexport B="two words"\nC='x'\n\nD=plain # trailing\nnot a pair\n`
      ),
      { A: '1', B: 'two words', C: 'x', D: 'plain' }
    )
  })
})

describe('buildLaunch', () => {
  const base = { mode: 'staging', debug: false, home: '/home/kaan' }

  it('merges the file without overriding variables already set', () => {
    const { env } = buildLaunch({
      ...base,
      env: { API_URL: 'from-shell' },
      fileEnv: { API_URL: 'from-file', ONLY_FILE: 'file' }
    })
    assert.equal(env.API_URL, 'from-shell')
    assert.equal(env.ONLY_FILE, 'file')
  })

  it('sets the environment and device, and always the renderer proxy', () => {
    const { env, args, control } = buildLaunch({
      ...base,
      env: { MEMRY_ENV: 'production' },
      fileEnv: {}
    })
    assert.equal(env.MEMRY_ENV, 'staging')
    assert.equal(env.MEMRY_DEVICE, 'dev')
    assert.equal(env.VITE_MEMRY_DEV_API_PROXY, '1')
    assert.deepEqual(args, ['exec', 'tauri', 'dev'])
    assert.equal(control, null)
    assert.equal(env.MEMRY_E2E, undefined)
  })

  it('debug adds the e2e build, the port and a control file with a persistent profile', () => {
    const { env, args, control } = buildLaunch({ ...base, debug: true, env: {}, fileEnv: {} })
    assert.equal(env.MEMRY_E2E, '1')
    assert.equal(env.TAURI_WEBDRIVER_PORT, String(DEBUG_PORT))
    assert.equal(DEBUG_PORT, 9333)
    assert.ok(args.join(' ').includes('--features e2e'))
    assert.deepEqual(control, {
      appDataDir: '/home/kaan/.memry/staging-tauri-profile/data',
      logDir: '/home/kaan/.memry/staging-tauri-profile/logs',
      device: 'dev',
      testVaultPath: null,
      syncServerUrl: null,
      extraEnv: {}
    })
  })
})
