import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { freePort, spawnApp, stopChild } from './app-process.ts'

const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])

// The app panics before its logging starts, as tao does when GTK cannot open the display: the
// text is only on stderr. Node stands in for the app, with a preload that writes and exits.
test('a launch that dies before its driver reports what the app wrote, and keeps it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memry-app-process-'))
  const preload = join(dir, 'panic.cjs')
  writeFileSync(
    preload,
    "process.stderr.write('Failed to initialize gtk backend!\\n'); process.exit(101)\n"
  )
  const saved = { binary: process.env.MEMRY_E2E_BINARY, options: process.env.NODE_OPTIONS }
  process.env.MEMRY_E2E_BINARY = process.execPath
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  t.after(() => {
    for (const [key, value] of [
      ['MEMRY_E2E_BINARY', saved.binary],
      ['NODE_OPTIONS', saved.options]
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })

  let message = ''
  await assert.rejects(spawnApp(await freePort()), (error) => {
    message = error instanceof Error ? error.message : String(error)
    return true
  })
  assert.match(message, /the app exited during startup \(code=101 signal=null\)/)
  assert.match(message, /Failed to initialize gtk backend!/)
  const output = /its output \((.+)\):/.exec(message)?.[1]
  assert.ok(output)
  assert.match(readFileSync(output, 'utf8'), /Failed to initialize gtk backend!/)
  rmSync(output)
})

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
  const exited = once(bystander, 'exit')
  Object.defineProperty(gone, 'pid', { value: bystander.pid })
  stopChild(gone)
  // Still alive for this signal: a kill by stopChild (SIGKILL, or taskkill's code 1 on Windows)
  // would have ended it first.
  bystander.kill('SIGTERM')
  const [, signal] = await exited
  assert.equal(signal, 'SIGTERM')
})
