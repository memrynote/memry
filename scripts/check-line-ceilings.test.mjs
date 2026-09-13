import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const script = resolve(scriptDir, 'check-line-ceilings.mjs')
const repoRoot = resolve(scriptDir, '..')

function run(cwd) {
  return execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' }).trim()
}

test('check-line-ceilings', async (t) => {
  await t.test('reports the same result from any working directory', () => {
    // The regression this exists for: the gate resolved its rule roots against
    // `process.cwd()`, so running it from `crates/` made every root ENOENT.
    // ENOENT is deliberately "not a violation" — a phase may not have created
    // a directory yet — so it scanned nothing and printed "passed". The gate
    // was believed, and a 613-line file went unnoticed.
    const fromRoot = run(repoRoot)
    const fromSubdir = run(resolve(repoRoot, 'crates'))
    const fromOutside = run(tmpdir())

    assert.equal(fromSubdir, fromRoot)
    assert.equal(fromOutside, fromRoot)
  })

  await t.test('says how many files it checked, and it is not zero', () => {
    // Without the count, a vacuous pass and a real pass are the same sentence.
    const output = run(repoRoot)
    const match = output.match(/passed \((\d+) files\)/)

    assert.ok(match, `expected a file count in: ${output}`)
    assert.ok(Number(match[1]) > 0, 'a pass over zero files is not a pass')
  })
})
