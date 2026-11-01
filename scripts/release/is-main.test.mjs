import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isMain } from './is-main.mjs'

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// A kill for a hung child, not a performance bound: generous for a cold start on a loaded runner.
const SPAWN_TIMEOUT_MS = 60_000

/** Links `target` at `link`, or returns false where Windows refuses this user symlinks. */
function trySymlink(target, link) {
  try {
    symlinkSync(target, link)
    return true
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return false
    throw error
  }
}

describe('isMain', () => {
  it('throws on a Node without import.meta.main instead of reading it as imported', () => {
    assert.throws(
      () => isMain({ filename: '/scripts/release/pe-imports.mjs' }),
      /\/scripts\/release\/pe-imports\.mjs needs import\.meta\.main/
    )
  })

  // Each program fails with its own error, which only its program branch prints, before it
  // reaches the network, a build or vpk. A path comparison against `process.argv[1]` skipped that
  // branch through a symlink and exited 0. pe-imports.test.mjs runs `pe-imports.mjs` this way.
  it('runs each release and rehearsal program started through a symlink', (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'is-main-'))
    const emptyPack = mkdtempSync(path.join(dir, 'pack-'))
    const programs = [
      {
        program: 'release/vpk-pack.mjs',
        args: ['win-x64', '--pack-dir', emptyPack],
        error: /WebView2 bootstrapper/
      },
      { program: 'release/stage-payload.mjs', args: [], error: /usage: stage-payload\.mjs/ },
      {
        program: 'release/webview2-bootstrapper.mjs',
        args: [],
        error: /usage: webview2-bootstrapper\.mjs/
      },
      { program: 'rehearsal/rehearse.mjs', args: [], error: /usage: rehearse\.mjs/ },
      {
        program: 'rehearsal/build-electron-rehearsal.mjs',
        args: [],
        error: /usage: build-electron-rehearsal\.mjs/
      },
      {
        program: 'rehearsal/drive-electron-update.mjs',
        args: [],
        error: /usage: drive-electron-update\.mjs/
      }
    ]
    for (const { program, args, error } of programs) {
      const link = path.join(dir, path.basename(program))
      if (!trySymlink(path.join(scripts, program), link)) {
        t.skip('Windows creates symlinks only in Developer Mode or as admin (EPERM)')
        return
      }
      const result = spawnSync(process.execPath, [link, ...args], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS
      })
      assert.notEqual(result.status, 0, `${program} exited 0 through a symlink`)
      assert.match(result.stderr, error, program)
    }
  })
})
