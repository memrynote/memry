import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { listCompanionPaths, stageWindowsPayload } from './stage-payload.mjs'

function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stage-payload-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), body)
  }
  return dir
}

const list = (dir, prefix = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? list(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  )

describe('stageWindowsPayload', () => {
  it('lays out Memrynote.exe plus the externalBin and resources the config lists', () => {
    const exeDir = fixture({
      'memry-tauri.exe': 'main',
      'memry-ml-worker.exe': 'worker',
      'resources/pdfium.dll': 'pdf',
      'other.dll': 'not listed',
      'memry-tauri.pdb': 'symbols'
    })
    const outDir = path.join(fixture({}), 'pack')
    const config = {
      bundle: { externalBin: ['binaries/memry-ml-worker'], resources: ['resources/pdfium.dll'] }
    }

    const staged = stageWindowsPayload({ exeDir, config, outDir })

    assert.deepEqual(staged, ['Memrynote.exe', 'memry-ml-worker.exe', 'resources/pdfium.dll'])
    assert.deepEqual(list(outDir).toSorted(), [
      'Memrynote.exe',
      'memry-ml-worker.exe',
      'resources/pdfium.dll'
    ])
    assert.equal(readFileSync(path.join(outDir, 'Memrynote.exe'), 'utf8'), 'main')
  })

  it('stages only the executable for a config with no companions', () => {
    const exeDir = fixture({ 'memry-tauri.exe': 'main' })
    const outDir = path.join(fixture({}), 'pack')
    assert.deepEqual(stageWindowsPayload({ exeDir, config: {}, outDir }), ['Memrynote.exe'])
  })

  it('fails when a listed file is missing beside the executable', () => {
    const exeDir = fixture({ 'memry-tauri.exe': 'main' })
    assert.throws(
      () =>
        stageWindowsPayload({
          exeDir,
          config: { bundle: { externalBin: ['binaries/memrynote-cli'] } },
          outDir: path.join(fixture({}), 'pack')
        }),
      /memrynote-cli\.exe/
    )
  })

  it('fails when the build produced no executable', () => {
    assert.throws(
      () => stageWindowsPayload({ exeDir: fixture({}), config: {}, outDir: fixture({}) }),
      /memry-tauri\.exe/
    )
  })

  it('maps parent-relative resources to _up_ and map-form resources to their targets', () => {
    assert.deepEqual(listCompanionPaths({ bundle: { resources: ['../shared/x.bin'] } }), [
      '_up_/shared/x.bin'
    ])
    assert.deepEqual(listCompanionPaths({ bundle: { resources: { 'a/b': 'data/b' } } }), ['data/b'])
  })
})
