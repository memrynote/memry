import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Main's ruleset requires `Rust CI gate` (#5221). A required check that never reports blocks the PR
// forever, and a skipped one counts as passed, so the gate must report on every PR, pass when no
// Rust CI path changed, and otherwise pass only when every Rust job succeeded.
const repo = new URL('..', import.meta.url).pathname
const workflow = readFileSync(join(repo, '.github/workflows/rust-ci.yml'), 'utf8')
const include = workflow.match(/include: '([^']+)'/)[1]
const pushPaths = [
  ...workflow.match(/^ {2}push:\n[\s\S]*?^ {4}paths:\n((?: {6}- '.*'\n)+)/m)[1].matchAll(/'(.*)'/g)
].map((m) => m[1])
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
const gate = jobs.slice(jobs.indexOf('\n  gate:\n'))

function changed(files) {
  const result = spawnSync('bash', [join(repo, '.github/actions/paths-changed/changed.sh')], {
    input: files.join('\n'),
    env: { PATH: process.env.PATH, INCLUDE: include, EXCLUDE: '^$' },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function runGate(env) {
  const script = gate.match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/)[1].replace(/^ {10}/gm, '')
  return spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8'
  }).status
}

describe('Rust CI gate', () => {
  it('runs on every pull request and merge group', () => {
    assert.match(workflow, /^ {2}pull_request:\n {2}\S/m)
    assert.match(workflow, /^ {2}merge_group:\n/m)
    assert.match(gate, /^ {4}name: Rust CI gate\n/m)
    assert.match(gate, /^ {4}if: \$\{\{ always\(\) \}\}\n/m)
  })

  it('runs the Rust jobs for every file the push filter lists, and none for a docs-only PR', () => {
    for (const path of pushPaths)
      assert.equal(changed([path.replace('**', 'x/y.rs')]), 'true', path)
    for (const [, action] of workflow.matchAll(/uses: \.\/\.github\/actions\/([a-z0-9-]+)/g))
      assert.ok(pushPaths.includes(`.github/actions/${action}/**`), action)
    assert.equal(changed(['apps/docs/src/contribute/testing.md', 'README.md']), 'false')
  })

  it('needs every other job', () => {
    const ids = [...jobs.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map((m) => m[1])
    const needs = gate.match(/needs: \[([^\]]+)\]/)[1].split(/,\s*/)
    assert.deepEqual(needs.toSorted(), ids.filter((id) => id !== 'gate').toSorted())
  })

  it('passes with no Rust change, and otherwise only when every job succeeded', () => {
    const skipped = 'success skipped skipped skipped'
    const passed = 'success success success success'
    assert.equal(runGate({ PATHS_RESULT: 'success', CHANGED: 'false', RESULTS: skipped }), 0)
    assert.equal(runGate({ PATHS_RESULT: 'success', CHANGED: 'true', RESULTS: passed }), 0)
    for (const results of [
      skipped,
      'success success failure success',
      'success cancelled success success'
    ])
      assert.equal(
        runGate({ PATHS_RESULT: 'success', CHANGED: 'true', RESULTS: results }),
        1,
        results
      )
    assert.equal(
      runGate({ PATHS_RESULT: 'failure', CHANGED: '', RESULTS: 'failure skipped skipped skipped' }),
      1
    )
    assert.equal(runGate({ PATHS_RESULT: 'success', CHANGED: '', RESULTS: skipped }), 1)
  })
})
