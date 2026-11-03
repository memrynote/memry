import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { failedWorkerReport } from './worker-report.ts'

test('a worker that died before its spec loaded is named with its spec, its app and the app log', async () => {
  const app = spawn(process.execPath, ['-e', ''])
  await once(app, 'exit')
  const port = 40_000 + Math.floor(Math.random() * 20_000)
  const root = join(tmpdir(), 'memry-e2e', `default-${port}`)
  mkdirSync(join(root, 'logs'), { recursive: true })
  const log = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)
  writeFileSync(join(root, 'logs', 'main.log'), `${log.join('\n')}\n`)
  try {
    const report = failedWorkerReport(
      {
        cid: '0-33',
        exitCode: 1,
        signal: null,
        specs: ['file:///repo/e2e/specs/shell/youtube-embed.e2e.ts'],
        retries: -1
      },
      [{ port, child: app }]
    ).split('\n')

    assert.equal(
      report[0],
      '[0-33] worker exited with code 1 before it loaded its spec, and wdio did not retry it: ' +
        'file:///repo/e2e/specs/shell/youtube-embed.e2e.ts'
    )
    assert.equal(
      report[1],
      `[0-33] the app the launcher started on port ${port} (pid ${app.pid}): exited with code 0`
    )
    assert.deepEqual(
      report.slice(3),
      log.slice(5).map((line) => `[0-33]   ${line}`)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
