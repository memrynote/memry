import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { versionConfig } from './version-config.mjs'

describe('versionConfig', () => {
  it('stamps release and rehearsal versions', () => {
    for (const version of ['2026.1025.1', '2026.101.12', '2099.101.30']) {
      assert.deepEqual(versionConfig(version), { version })
    }
  })

  it('rejects what Tauri or the Windows version resource cannot hold', () => {
    for (const version of [
      undefined,
      '',
      'v2026-10-25',
      '2026.1025',
      '2026.0101.1',
      '0.0.0',
      '0.1.2',
      '2026.70000.1',
      '1.2.3-beta'
    ]) {
      assert.throws(() => versionConfig(version), /not a release version/, String(version))
    }
  })

  it('writes the overlay tauri build --config reads', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'version-config-'))
    try {
      const out = path.join(dir, 'version.conf.json')
      const script = path.join(import.meta.dirname, 'version-config.mjs')
      const ok = spawnSync(process.execPath, [script, '2099.101.30', out], { encoding: 'utf8' })
      assert.equal(ok.status, 0, ok.stderr)
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { version: '2099.101.30' })
      const bad = spawnSync(process.execPath, [script, '0.0.0.1', out], { encoding: 'utf8' })
      assert.equal(bad.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
