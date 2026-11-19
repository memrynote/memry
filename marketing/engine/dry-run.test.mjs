import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { checkFails, dryRun } from './dry-run.mjs'

function clip(scenes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'film-check-'))
  writeFileSync(
    path.join(dir, 'narration.json'),
    JSON.stringify({ silent: true, scenes: [{ id: 'one', dur: 1 }] })
  )
  writeFileSync(path.join(dir, 'scenes.mjs'), scenes)
  return dir
}

test('a clip that drives the Electron main process fails --check', async () => {
  const dir = clip(
    '// node apps/desktop/scripts/agent-app.mjs eval\nexport const scenes = { one: async () => {} }'
  )
  const report = await dryRun(dir)
  assert.equal(report.electronMain, true)
  assert.equal(checkFails(report), true)
  assert.equal(checkFails({ ...report, electronMain: false }), false)
})

test('each dry run loads its own scenes module, with no app checkout set', async () => {
  const dir = clip(`globalThis.__filmLoads = (globalThis.__filmLoads ?? 0) + 1
export const scenes = {
  one: async () => {
    globalThis.__filmApp = process.env.MEMRY_SOCIAL_APP
  }
}`)
  process.env.MEMRY_SOCIAL_APP = '/some/checkout'
  try {
    await dryRun(dir)
    await dryRun(dir)
    assert.equal(globalThis.__filmLoads, 2)
    assert.equal(globalThis.__filmApp, undefined)
    assert.equal(process.env.MEMRY_SOCIAL_APP, '/some/checkout')
  } finally {
    delete process.env.MEMRY_SOCIAL_APP
  }
})
