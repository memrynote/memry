import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NOTES, block, noteMarkdown, summarize } from './typing-bench.mjs'

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
