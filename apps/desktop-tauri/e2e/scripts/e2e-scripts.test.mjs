import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { electronHookNames, unmapped } from './check-test-hooks-mapped.mjs'
import { filterSpecs } from './changed-specs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checker = join(here, 'check-test-hooks-mapped.mjs')
const hooksMd = readFileSync(join(here, '../HOOKS.md'), 'utf8')

test('HOOKS.md maps every Electron test hook', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(electronHookNames().length >= 41)
})

test('the checker exits 1 and names a hook removed from HOOKS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-md-'))
  try {
    const copy = join(dir, 'HOOKS.md')
    writeFileSync(copy, hooksMd.replace('`getCrdtPendingCount`', 'removed'))
    const result = spawnSync(process.execPath, [checker, '--hooks-md', copy], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /getCrdtPendingCount/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unmapped compares backticked names', () => {
  assert.deepEqual(unmapped(['a', 'b'], 'x `a` y'), ['b'])
})

test('changed-specs keeps only spec files', () => {
  assert.deepEqual(
    filterSpecs([
      'e2e/specs/shell/startup.e2e.ts',
      'e2e/specs/shell/notes.md',
      'e2e/harness/test.ts',
      ''
    ]),
    ['e2e/specs/shell/startup.e2e.ts']
  )
})
