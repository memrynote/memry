import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  collectFlaky,
  commentBody,
  flakyTests,
  prFromRef,
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

// A seams leg keeps one report per nextest step (rust-ci.yml): a flake in any of them is reported.
test('a seams artifact with one report per nextest step reports the flaky test of each', () => {
  const root = mkdtempSync(join(tmpdir(), 'flaky-'))
  const dir = join(root, 'nextest-junit-ubuntu-22.04-1')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'memry-ml.xml'),
    '<testsuite><testcase name="a" classname="memry-ml"/></testsuite>'
  )
  cpSync(fixture, join(dir, 'sync-harness.xml'))
  assert.deepEqual(
    [...collectFlaky(root)],
    [
      [
        'memry-tauri::ml_embedding_lane a_vault_close_stops_the_model',
        [{ leg: 'ubuntu-22.04', failedAttempts: 1 }]
      ]
    ]
  )
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
