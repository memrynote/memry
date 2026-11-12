import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NOTES, assertNoRunningSandbox, block, noteMarkdown, summarize } from './typing-bench.mjs'

test('the long bench note has 5000 blocks and starts with the caret line', () => {
  const long = NOTES.find((note) => note.blocks === 5000)
  const markdown = noteMarkdown(long)
  const body = markdown.slice(markdown.indexOf('---\n\n') + 5).trimEnd()
  assert.equal(body.split('\n\n').length, 5000)
  assert.ok(body.startsWith(block(0)))
})

test('summarize reports the nearest-rank p50 and p95', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i)
  assert.deepEqual(summarize(samples), { n: 100, p50: 51, p95: 96, max: 100 })
})

test('a live sandbox from another session stops the bench before it starts or stops anything', () => {
  const live = JSON.stringify({ pid: 4242, port: 9222, alive: true })
  assert.throws(() => assertNoRunningSandbox('tauri', live), /already runs \(pid 4242\)/)
})

test('no state file, or a state file of a dead app, lets the bench start', () => {
  assert.doesNotThrow(() => assertNoRunningSandbox('electron', 'Not running.\n'))
  const dead = JSON.stringify({ pid: 4242, port: 9222, alive: false })
  assert.doesNotThrow(() => assertNoRunningSandbox('tauri', dead))
})
