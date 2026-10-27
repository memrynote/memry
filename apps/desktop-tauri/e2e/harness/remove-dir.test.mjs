import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { removeDir } from './remove-dir.ts'

test('removeDir deletes a tree and tolerates a missing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'remove-dir-'))
  mkdirSync(join(root, 'a/b'), { recursive: true })
  writeFileSync(join(root, 'a/b/file.txt'), 'x')

  removeDir(root)
  removeDir(root)

  assert.equal(existsSync(root), false)
})
