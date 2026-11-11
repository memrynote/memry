import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { withOsClipboard } from './os-clipboard.ts'

const tempLock = () => join(mkdtempSync(join(tmpdir(), 'os-clipboard-')), 'os-clipboard.lock')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('holders take turns, and a failed holder still lets the next one in', async () => {
  const lock = tempLock()
  const events = []
  const hold = (name, fail) =>
    withOsClipboard(
      async () => {
        events.push(`${name} in`)
        await pause(100)
        events.push(`${name} out`)
        if (fail) throw new Error(`${name} failed`)
      },
      { lock }
    )

  const results = await Promise.allSettled([hold('a', true), hold('b', false)])

  assert.deepEqual(events, ['a in', 'a out', 'b in', 'b out'])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(existsSync(lock), false)
})

test('a lock left by a worker that died is taken over', async () => {
  const lock = tempLock()
  const dead = spawnSync(process.execPath, ['-e', 'process.pid'])
  writeFileSync(lock, String(dead.pid))

  assert.equal(await withOsClipboard(async () => 'held', { lock, timeoutMs: 2_000 }), 'held')
})
