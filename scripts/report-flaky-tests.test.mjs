import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseQuarantine, validate } from './check-quarantine.mjs'
import {
  alarmBody,
  baseFromRef,
  alarmMarker,
  collectFlaky,
  commentBody,
  exhaustedTests,
  flakyTests,
  prFromRef,
  repeatOffenders,
  runMarker
} from './report-flaky-tests.mjs'

// Written by cargo-nextest 0.9.150 under the merge-queue profile (retries = 2): one test passes,
// one fails once then passes, one fails all three attempts.
const fixture = new URL('./fixtures/nextest-junit-flaky.xml', import.meta.url)

test('a test that passed on retry is flaky; a pass and a failure on every attempt are not', () => {
  assert.deepEqual(flakyTests(readFileSync(fixture, 'utf8')), [
    { name: 'memry-tauri::ml_embedding_lane a_vault_close_stops_the_model', failedAttempts: 1 }
  ])
})

test('a run with no retries has no flaky tests', () => {
  const xml =
    '<testsuite><testcase name="a" classname="c"/><testcase name="b" classname="c"><failure>x</failure></testcase></testsuite>'
  assert.deepEqual(flakyTests(xml), [])
})

test('one test flaky on two legs is one entry naming both legs; artifacts without junit are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'flaky-'))
  for (const dir of ['nextest-junit-ubuntu-22.04-1', 'nextest-junit-windows-2022-4']) {
    mkdirSync(join(root, dir))
    cpSync(fixture, join(root, dir, 'junit.xml'))
  }
  mkdirSync(join(root, 'nextest-junit-windows-11-arm-7'))
  const byTest = collectFlaky(root)
  assert.deepEqual(
    [...byTest],
    [
      [
        'memry-tauri::ml_embedding_lane a_vault_close_stops_the_model',
        [
          { leg: 'ubuntu-22.04', failedAttempts: 1 },
          { leg: 'windows-2022', failedAttempts: 1 }
        ]
      ]
    ]
  )

  const body = commentBody(byTest, {
    runId: '43814693425',
    runUrl: 'https://github.com/memrynote/memry/actions/runs/43814693425',
    pr: '4746'
  })
  assert.ok(body.startsWith(runMarker('43814693425')))
  assert.match(
    body,
    /for #4746, run https:\/\/github\.com\/memrynote\/memry\/actions\/runs\/43814693425/
  )
  assert.match(
    body,
    /- `memry-tauri::ml_embedding_lane a_vault_close_stops_the_model` \(ubuntu-22\.04, failed 1x before passing; windows-2022, failed 1x before passing\)/
  )
})

test('the PR number comes from the merge-group ref', () => {
  assert.equal(
    prFromRef(
      'refs/heads/gh-readonly-queue/feat/tauri-v2/pr-4746-0a25cafab7c9e0d1f2a3b4c5d6e7f8a9b0c1d2e3'
    ),
    '4746'
  )
  assert.equal(prFromRef('refs/heads/feat/tauri-v2'), '')
})

test('a test that failed every attempt is exhausted; a pass and a pass on retry are not', () => {
  assert.deepEqual(exhaustedTests(readFileSync(fixture, 'utf8')), [
    'memry-tauri::ml_embedding_lane a_test_that_always_fails'
  ])
})

test('the alarm fires for a test exhausted in two PRs, not for one PR twice or a run without a PR', () => {
  const run = (id, pr, tests) => ({
    id,
    url: `https://example.test/runs/${id}`,
    pr,
    onBranch: true,
    tests
  })
  const offenders = repeatOffenders([
    run(1, '10', ['c a', 'c b', 'c a']),
    run(2, '10', ['c b']),
    run(3, '11', ['c a']),
    run(4, '', ['c b'])
  ])
  assert.deepEqual(
    offenders.map(({ test: name, runs }) => [name, runs.map(({ id }) => id)]),
    [['c a', [1, 3]]]
  )
})

test('groups stacked on a failed group do not count as other PRs', () => {
  // The nested_tx wave of 25 Nov: #5793's group was built on the branch, #5795's on #5793's group
  // commit, #5799's on #5795's. #5793's own guard failed in all three.
  const test_ =
    'memry-core storage::nested_tx::tests::no_core_write_opens_a_transaction_that_cannot_nest'
  const runs = [
    ['pr-5793-5a0a61d1', true],
    ['pr-5795-3886b10d', false],
    ['pr-5799-c6ea17f4', false]
  ].map(([ref, onBranch], id) => ({
    id,
    url: `https://example.test/runs/${id}`,
    pr: prFromRef(`refs/heads/gh-readonly-queue/feat/tauri-v2/${ref}`),
    onBranch,
    tests: [test_]
  }))
  assert.deepEqual(repeatOffenders(runs), [])
  assert.equal(baseFromRef('gh-readonly-queue/feat/tauri-v2/pr-5795-3886b10d'), '3886b10d')
})

test('the alarm issue carries a quarantine entry the checker accepts once an owner is set', () => {
  const today = new Date('2026-11-20T12:00:00Z')
  const name = 'memry-core::integration move_journal::an_open_that_keeps_both_copies_says_so'
  const issue = 'https://github.com/memrynote/memry/issues/5900'
  const body = alarmBody(
    name,
    [{ id: 7, url: 'https://example.test/runs/7', pr: '10' }],
    issue,
    today
  )
  assert.ok(body.startsWith(alarmMarker(name)))
  const toml = body.match(/```toml\n([\s\S]*?)```/)[1]
  const { entries, errors } = parseQuarantine(toml.replace('<github login>', 'h4yfans'))
  assert.deepEqual(errors, [])
  assert.deepEqual(validate(entries, today), [])
  assert.equal(entries[0].test, name)
  assert.equal(entries[0].issue, issue)
})
