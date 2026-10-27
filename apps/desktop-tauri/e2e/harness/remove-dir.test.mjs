import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { removeDir, retryWhileHeld } from './remove-dir.ts'

test('removeDir deletes a tree and tolerates a missing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'remove-dir-'))
  mkdirSync(join(root, 'a/b'), { recursive: true })
  writeFileSync(join(root, 'a/b/file.txt'), 'x')

  removeDir(root)
  removeDir(root)

  assert.equal(existsSync(root), false)
})

test('retryWhileHeld waits out a handle that is still closing, then succeeds', () => {
  let calls = 0
  const result = retryWhileHeld(() => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' })
    return 'removed'
  })

  assert.equal(result, 'removed')
  assert.equal(calls, 3)
})

test('retryWhileHeld throws any other error at once', () => {
  let calls = 0
  assert.throws(
    () =>
      retryWhileHeld(() => {
        calls += 1
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
    /ENOENT/
  )
  assert.equal(calls, 1)
})
