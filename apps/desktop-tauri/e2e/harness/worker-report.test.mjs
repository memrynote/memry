import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { failedWorkerReport } from './worker-report.ts'

const SPEC = 'file:///repo/e2e/specs/shell/youtube-embed.e2e.ts'

function logDirWith(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-report-'))
  if (lines) writeFileSync(join(dir, 'main.log'), `${lines.join('\n')}\n`)
  return dir
}

test('a worker that died before its spec loaded is named with its spec, its app and the app log', async () => {
  const app = spawn(process.execPath, ['-e', ''])
  await once(app, 'exit')
  const log = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)
  const logDir = logDirWith(log)
  try {
    const report = failedWorkerReport(
      { cid: '0-33', exitCode: 1, signal: null, specs: [SPEC], retries: -1 },
      [{ port: 51234, child: app, logDir }]
    ).split('\n')

    assert.equal(
      report[0],
      `[0-33] worker exited with code 1 before it loaded its spec, and wdio did not retry it: ${SPEC}`
    )
    assert.equal(
      report[1],
      `[0-33] the app the launcher started on port 51234 (pid ${app.pid}): exited with code 0`
    )
    assert.deepEqual(
      report.slice(3),
      log.slice(5).map((line) => `[0-33]   ${line}`)
    )
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('a worker that loaded its spec, and an app that never brought up its driver', () => {
  const logDir = logDirWith(['no driver'])
  try {
    const report = failedWorkerReport(
      { cid: '0-2', exitCode: 1, signal: 'SIGKILL', specs: [SPEC], retries: 0 },
      [{ port: 51235, logDir }]
    ).split('\n')

    assert.deepEqual(report, [
      `[0-2] worker exited with signal SIGKILL: ${SPEC}`,
      '[0-2] the app the launcher started on port 51235: did not start',
      '[0-2] its main.log, last 20 lines:',
      '[0-2]   no driver'
    ])
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
