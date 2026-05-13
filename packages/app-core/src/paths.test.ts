import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePath } from './paths.ts'

test('normalizes vault-relative paths without repeated-slash regex backtracking', () => {
  assert.equal(normalizePath('///notes\\Projects/CLI Note.md///'), 'notes/Projects/CLI Note.md')
  assert.equal(normalizePath('////'), '')
})
