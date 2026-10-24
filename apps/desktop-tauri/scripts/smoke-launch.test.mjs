import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { smokeLaunch } from './smoke-launch.mjs'

let dir

// A stand-in for the app: appends the given lines to main.log in MEMRY_TEST_LOG_DIR, then idles.
function fakeBinary(name, lines) {
  const file = join(dir, name)
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const logDir = process.env.MEMRY_TEST_LOG_DIR
mkdirSync(logDir, { recursive: true })
for (const line of ${JSON.stringify(lines)}) appendFileSync(join(logDir, 'main.log'), line + '\\n')
setInterval(() => {}, 1000)
`
  )
  chmodSync(file, 0o755)
  return file
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'smoke-launch-test-'))
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('smokeLaunch', () => {
  it('passes when both log lines appear and the process stays up', async () => {
    const binary = fakeBinary('ok.mjs', [
      '2026-01-01 INFO MemryNote 0.0.0 starting (dev)',
      '2026-01-01 INFO renderer started'
    ])

    const result = await smokeLaunch(binary, { timeoutMs: 10_000, settleMs: 300, xvfb: false })

    assert.equal(result.ok, true)
  })

  it('fails with the log tail when the renderer line never comes', async () => {
    const binary = fakeBinary('late.mjs', ['2026-01-01 INFO MemryNote 0.0.0 starting (packaged)'])

    const result = await smokeLaunch(binary, { timeoutMs: 1_500, settleMs: 100, xvfb: false })

    assert.equal(result.ok, false)
    assert.match(result.log, /starting \(packaged\)/)
  })
})
