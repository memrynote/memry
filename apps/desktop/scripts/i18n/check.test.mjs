import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(scriptsRoot, '../..')
const checkScript = path.join(scriptsRoot, 'check.mjs')
const fixtureRoot = path.join(scriptsRoot, 'fixtures/check')

function runCheck(args) {
  return spawnSync(process.execPath, [checkScript, ...args], {
    cwd: desktopRoot,
    encoding: 'utf8'
  })
}

test('--paths exits 0 for passing fixture', () => {
  const result = runCheck(['--paths', path.join(fixtureRoot, 'pass.tsx')])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /ok: i18n check passed/)
})

test('missing English key exits 1 and reports key plus file path', () => {
  const result = runCheck(['--paths', path.join(fixtureRoot, 'missing-key.tsx')])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /notes:missing\.phaseEKey/)
  assert.match(result.stdout, /missing-key\.tsx/)
})

test('all locale resources are complete', () => {
  const result = runCheck(['--paths', path.join(fixtureRoot, 'pass.tsx')])

  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout, /warn: \d+ keys missing in [^/]+\/\*/)
})

test('orphan English keys warn but do not fail', () => {
  const result = runCheck(['--paths', path.join(fixtureRoot, 'pass.tsx')])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /English keys not referenced/)
})

test('default source check has no warnings', () => {
  const result = runCheck([])

  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout, /^warn:/m)
})

test('--format json emits parseable JSON', () => {
  const result = runCheck(['--paths', path.join(fixtureRoot, 'pass.tsx'), '--format', 'json'])

  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.filesScanned, 1)
})

test('--max-todo fails when TODO straggler count exceeds limit', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-i18n-check-'))
  const fixturePath = path.join(tempDir, 'todo.tsx')
  fs.writeFileSync(
    fixturePath,
    `export function Todo() {\n  return <button>{/* TODO(i18n): wrap in t() */}Create Note</button>\n}\n`
  )

  const result = runCheck(['--paths', fixturePath, '--max-todo', '0'])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /exceeds --max-todo 0/)
})
