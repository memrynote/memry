import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assert.equal(result.phase, 'startup marker logged, renderer never called app_info')
  })

  it(
    'kills the whole process group, grandchildren included',
    { skip: process.platform === 'win32' },
    async () => {
      const pidFile = join(dir, 'grandchild.pid')
      const file = join(dir, 'group.mjs')
      writeFileSync(
        file,
        `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const logDir = process.env.MEMRY_TEST_LOG_DIR
mkdirSync(logDir, { recursive: true })
const grandchild = spawn('sleep', ['600'], { stdio: 'inherit' })
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
appendFileSync(join(logDir, 'main.log'), 'MemryNote 0.0.0 starting (dev)\\nrenderer started\\n')
setInterval(() => {}, 1000)
`
      )
      chmodSync(file, 0o755)

      const result = await smokeLaunch(file, { timeoutMs: 10_000, settleMs: 100, xvfb: false })

      assert.equal(result.ok, true)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }
  )

  it('names the startup phase when nothing is logged', async () => {
    const binary = fakeBinary('silent.mjs', [])

    const result = await smokeLaunch(binary, { timeoutMs: 1_000, settleMs: 100, xvfb: false })

    assert.equal(result.ok, false)
    assert.equal(result.phase, 'no startup marker')
  })

  it('with expectNoDriver passes when MEMRY_E2E starts no server', async () => {
    const binary = fakeBinary('nodriver.mjs', [
      '2026-01-01 INFO MemryNote 0.0.0 starting (packaged)',
      '2026-01-01 INFO renderer started'
    ])

    const result = await smokeLaunch(binary, {
      timeoutMs: 10_000,
      settleMs: 300,
      xvfb: false,
      expectNoDriver: true
    })

    assert.equal(result.ok, true)
    assert.equal(result.driver, false)
  })

  it('with expectNoDriver fails when the WebDriver port is listening', async () => {
    const file = join(dir, 'driver.mjs')
    writeFileSync(
      file,
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
const logDir = process.env.MEMRY_TEST_LOG_DIR
mkdirSync(logDir, { recursive: true })
net.createServer().listen(Number(process.env.TAURI_WEBDRIVER_PORT), '127.0.0.1')
appendFileSync(join(logDir, 'main.log'), 'MemryNote 0.0.0 starting (dev)\\nrenderer started\\n')
`
    )
    chmodSync(file, 0o755)

    const result = await smokeLaunch(file, {
      timeoutMs: 10_000,
      settleMs: 300,
      xvfb: false,
      expectNoDriver: true
    })

    assert.equal(result.ok, false)
    assert.equal(result.driver, true)
  })
})
