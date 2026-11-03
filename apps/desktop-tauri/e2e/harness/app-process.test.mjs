import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

import { stopChild } from './app-process.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])

test('stopChild ends a child that still runs', async () => {
  const child = idle()
  const exited = once(child, 'exit')
  stopChild(child)
  await exited
})

// Windows hands the pid of an exited process to the next one at once. The launcher's app is
// closed by the first test long before the worker ends, so its pid may name another worker by then.
test('stopChild leaves alone the process that took an exited child pid', async () => {
  const gone = spawn(process.execPath, ['-e', ''])
  await once(gone, 'exit')
  const bystander = idle()
  let bystanderExited = false
  bystander.once('exit', () => {
    bystanderExited = true
  })
  Object.defineProperty(gone, 'pid', { value: bystander.pid })
  try {
    stopChild(gone)
    await sleep(1_000)
    assert.equal(bystanderExited, false)
  } finally {
    bystander.kill('SIGKILL')
  }
})
