import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Main's ruleset requires `Rust CI gate` (#5221), and so does feat/tauri-v2's merge queue (#3517). A
// required check that never reports blocks the PR forever, and a skipped one counts as passed, so the
// gate must report on every PR, fail when a needed job failed, and on a PR that changes a Rust CI
// path pass only when the Rust legs ran and passed.
const repo = new URL('..', import.meta.url).pathname
const workflow = readFileSync(join(repo, '.github/workflows/rust-ci.yml'), 'utf8')
// The plan job's `Detect changed paths` step is the first include in the file.
const include = workflow.match(/include: '([^']+)'/)[1]
const pushPaths = [
  ...workflow
    .match(/^ {2}push:\n[\s\S]*?^ {4}paths:\n((?: {6}(?:- '.*'|#.*)\n)+)/m)[1]
    .matchAll(/^ {6}- '(.*)'$/gm)
].map((m) => m[1])
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
const gateStart = jobs.indexOf('\n  gate:\n')
const gateEnd = jobs.slice(gateStart + 1).search(/\n {2}[a-z0-9-]+:\n/)
const gate = jobs.slice(gateStart, gateEnd === -1 ? undefined : gateStart + 1 + gateEnd)
// A `labeled` or `opened` event that only feat/tauri-v2's `full-ci` tiering acts on runs no job (the
// concurrency group names it); every other run is a real one.
const noop = workflow.match(/^ {2}group: rust-ci-.*?\$\{\{ (\(\(.*?\)\)\)) && format\('-noop-/m)[1]
// Not gate dependencies, each for the reason rust-ci.yml gives: the iOS unit plan (intermittent tests
// on the shared macOS pool), the flaky-test report (logging a flake never ejects a PR) and the
// scheduled-failure report (it needs the gate).
const notGated = ['ios-unit-tests', 'flaky-report', 'report']

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
    const pullRequest = workflow.match(/^ {2}pull_request:\n((?: {4}.*\n)*)/m)[1]
    assert.doesNotMatch(pullRequest, /^ {4}(paths|paths-ignore|branches|branches-ignore):/m)
    const types = pullRequest.match(/^ {4}types: \[([^\]]+)\]/m)
    if (types) {
      for (const type of ['opened', 'synchronize', 'reopened'])
        assert.ok(types[1].split(/,\s*/).includes(type), type)
    }
    assert.match(workflow, /^ {2}merge_group:\n/m)
    assert.match(gate, /^ {4}name: Rust CI gate\n/m)
    // Skipped only in a noop run into feat/tauri-v2: PRs into main, pushes and the merge queue all
    // see it report.
    assert.equal(
      gate.match(/^ {4}if: (.*)$/m)[1],
      `\${{ always() && !(${noop} && github.base_ref != 'main') }}`
    )
    assert.equal(gate.match(/^ {10}MIRROR: \$\{\{ (.*) \}\}$/m)[1], noop)
  })

  it('runs the Rust jobs for every file the push filter lists, and none for a docs-only PR', () => {
    for (const path of pushPaths)
      assert.equal(changed([path.replace('**', 'x/y.rs').replace('*', '')]), 'true', path)
    for (const [, action] of workflow.matchAll(/uses: \.\/\.github\/actions\/([a-z0-9-]+)/g))
      assert.ok(pushPaths.includes(`.github/actions/${action}/**`), action)
    assert.equal(changed(['apps/docs/src/contribute/testing.md', 'README.md']), 'false')
  })

  it('needs every other job but the ones it leaves out on purpose', () => {
    const ids = [...jobs.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map((m) => m[1])
    for (const id of notGated) assert.ok(ids.includes(id), id)
    const needs = gate
      .match(/needs:\s*\[([^\]]+)\]/)[1]
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    assert.deepEqual(
      needs.toSorted(),
      ids.filter((id) => id !== 'gate' && !notGated.includes(id)).toSorted()
    )
  })

  it('fails on a failed job, and on a PR that changes a Rust CI path unless the Rust legs passed', () => {
    const pr = { DETECT_RESULT: 'success', EVENT: 'pull_request', CHANGED: 'true' }
    const passed = 'success success success success success'
    const skipped = 'success skipped skipped skipped skipped'
    assert.equal(runGate({ ...pr, CHANGED: 'false', RUST_RESULT: 'skipped', RESULTS: skipped }), 0)
    assert.equal(runGate({ ...pr, RUST_RESULT: 'success', RESULTS: passed }), 0)
    // The tier skips the legs a diff cannot break.
    const tiered = 'success success skipped skipped success'
    assert.equal(runGate({ ...pr, RUST_RESULT: 'success', RESULTS: tiered }), 0)
    // A push the merge queue already passed skips the Rust legs.
    const covered = { ...pr, EVENT: 'push', RUST_RESULT: 'skipped', RESULTS: skipped }
    assert.equal(runGate(covered), 0)
    assert.equal(runGate({ ...pr, RUST_RESULT: 'skipped', RESULTS: skipped }), 1)
    for (const [rust, results] of [
      ['failure', 'success failure success success success'],
      ['cancelled', 'success cancelled success success success'],
      ['success', 'success success success success failure']
    ])
      assert.equal(runGate({ ...pr, RUST_RESULT: rust, RESULTS: results }), 1, results)
    const noPlan = 'failure skipped skipped skipped skipped'
    assert.equal(
      runGate({
        ...pr,
        DETECT_RESULT: 'failure',
        CHANGED: '',
        RUST_RESULT: 'skipped',
        RESULTS: noPlan
      }),
      1
    )
    assert.equal(runGate({ ...pr, CHANGED: '', RUST_RESULT: 'skipped', RESULTS: skipped }), 1)
  })

  it('reports the latest finished gate of a real run in a noop run into main', () => {
    const bin = mkdtempSync(join(tmpdir(), 'rust-ci-gate-'))
    try {
      // A stand-in `gh` that answers the check-runs query with the conclusion it is given.
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "%s" "$LATEST"\n')
      chmodSync(join(bin, 'gh'), 0o755)
      const path = `${bin}:${process.env.PATH}`
      // Every needed job is skipped in a noop run, so only the mirrored conclusion decides.
      const noopRun = { MIRROR: 'true', DETECT_RESULT: 'skipped', RESULTS: 'skipped skipped' }
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: 'success' }), 0)
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: 'failure' }), 1)
      // No real run has finished yet: red until that run's own gate supersedes this one.
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: '' }), 1)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
