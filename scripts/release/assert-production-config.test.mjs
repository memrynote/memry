import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { assertProductionSyncServerUrl, scanPayload } from './assert-production-config.mjs'

const script = path.join(import.meta.dirname, 'assert-production-config.mjs')
const SYNC = 'https://sync.memrynote.com'
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
const PE = Buffer.from('MZ')

// Strings every real build holds (memry-desktop config.rs, tls/pins.rs, the Tauri IPC origin).
const ALWAYS = 'http://localhost:8787\0sync-staging.memrynote.com\0http://ipc.localhost'
const MAIN = `${ALWAYS}\0${SYNC}\0https://github.com/memrynote/memry\0`

function payload(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'payload-'))
  for (const [name, [magic, text]] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), Buffer.concat([magic, Buffer.from(text)]))
  }
  return dir
}

function withPayload(files, fn) {
  const dir = payload(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('assertProductionSyncServerUrl', () => {
  it('accepts the production https URL', () => {
    assert.equal(assertProductionSyncServerUrl(` ${SYNC} `), SYNC)
  })

  it('rejects a missing, invalid, plain-http, local or staging URL', () => {
    const cases = [
      [undefined, /must be configured/],
      ['  ', /must be configured/],
      ['sync.memrynote.com', /valid URL/],
      ['http://sync.memrynote.com', /HTTPS/],
      ['https://localhost:8787', /production sync host/],
      ['https://127.0.0.1', /production sync host/],
      ['https://[::1]:8787', /production sync host/],
      ['https://sync-staging.memrynote.com', /production sync host/],
      ['https://sync.example.com', /production sync host/],
      ['https://sync.memrynote.com.example.com', /production sync host/],
      ['https://memrynote.com', /production sync host/]
    ]
    for (const [value, error] of cases) {
      assert.throws(() => assertProductionSyncServerUrl(value), error, String(value))
    }
  })
})

describe('scanPayload', () => {
  it('passes a payload whose executables carry only production values', () => {
    withPayload(
      {
        'MemryNote.app/Contents/MacOS/MemryNote': [MACHO, MAIN],
        'MemryNote.app/Contents/MacOS/memry-ml-worker': [MACHO, 'worker'],
        'MemryNote.app/Contents/Resources/notes.txt': [Buffer.from('#'), 'memry-update-rehearsal']
      },
      (dir) => assert.deepEqual(scanPayload(dir, SYNC), [])
    )
  })

  // MEMRY_UPDATE_FEED_URL set to the rehearsal repo compiles the rehearsal feed into the binary.
  it('fails on a rehearsal feed or a staging sync URL in any executable', () => {
    withPayload(
      {
        'Memrynote.exe': [PE, `${MAIN}https://github.com/memrynote/memry-update-rehearsal`],
        'memry-ml-worker.exe': [PE, 'https://sync-staging.memrynote.com']
      },
      (dir) =>
        assert.deepEqual(scanPayload(dir, SYNC), [
          'Memrynote.exe contains "memry-update-rehearsal"',
          'memry-ml-worker.exe contains "://sync-staging"'
        ])
    )
  })

  it('fails when no executable holds the sync URL or the production feed', () => {
    withPayload({ 'usr/bin/memrynote': [ELF, ALWAYS] }, (dir) =>
      assert.deepEqual(scanPayload(dir, SYNC), [
        `no executable contains "${SYNC}"`,
        'no executable contains "https://github.com/memrynote/memry"'
      ])
    )
  })

  it('fails on a payload with no executable', () => {
    withPayload({ 'readme.txt': [Buffer.from('#'), MAIN] }, (dir) =>
      assert.match(scanPayload(dir, SYNC)[0], /no executable under/)
    )
  })
})

describe('assert-production-config cli', () => {
  const run = (args, env) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })

  it('runs pre and post with SYNC_SERVER_URL', () => {
    assert.equal(run(['pre'], { SYNC_SERVER_URL: SYNC }).status, 0)
    const pre = run(['pre'], { SYNC_SERVER_URL: 'https://sync-staging.memrynote.com' })
    assert.equal(pre.status, 1)
    assert.match(pre.stderr, /production sync host/)
    withPayload({ 'usr/bin/memrynote': [ELF, `${MAIN}memry-update-rehearsal`] }, (dir) => {
      const post = run(['post', dir], { SYNC_SERVER_URL: SYNC })
      assert.equal(post.status, 1)
      assert.match(post.stderr, /contains "memry-update-rehearsal"/)
    })
    assert.match(run(['post'], { SYNC_SERVER_URL: SYNC }).stderr, /usage/)
  })
})
