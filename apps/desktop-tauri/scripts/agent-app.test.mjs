import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'

import { main } from './agent-app.mjs'

let root
let fakeBinary

// Stands in for the e2e app: serves /status, /session, the execute/async calls `agent-app.mjs`
// makes (e2e_app_info, e2e_request_quit, eval) and writes its environment next to the control
// file, so the test can read what the script spawned it with.
const FAKE_APP = `#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.TAURI_WEBDRIVER_PORT)
const control = JSON.parse(readFileSync(join(tmpdir(), 'memry-e2e', 'control-' + port + '.json'), 'utf8'))
writeFileSync(join(control.appDataDir, 'env.json'), JSON.stringify({ MEMRY_E2E: process.env.MEMRY_E2E, port }))
const reply = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value })) }
createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (req.url === '/status') return reply(res, { ready: true, message: 'ok' })
    if (req.url === '/session') return reply(res, { sessionId: 's1', capabilities: {} })
    if (req.url === '/session/s1/window/handles') return reply(res, ['main'])
    if (req.url === '/session/s1/screenshot') return reply(res, Buffer.from('PNG').toString('base64'))
    if (req.url === '/session/s1/execute/async') {
      const { args } = JSON.parse(body)
      if (args[0] === 'e2e_app_info') return reply(res, { ok: true, value: { device: control.device, pid: process.pid } })
      if (args[0] === 'e2e_request_quit') {
        reply(res, { ok: true, value: null })
        return setTimeout(() => process.exit(0), 50)
      }
      const { script } = JSON.parse(body)
      if (script.includes('return (\\ndocument.title\\n)')) return reply(res, { ok: true, value: 'MemryNote' })
      if (script.includes('return (\\n1 + 1\\n)')) return reply(res, { ok: true, value: 2 })
      if (script.includes('return (\\nconst a')) {
        res.statusCode = 500
        return reply(res, { error: 'javascript error', message: 'SyntaxError: Unexpected token const' })
      }
      if (script.includes('{ const a = 3; return a }')) return reply(res, { ok: true, value: 3 })
      return reply(res, { ok: false, error: 'ReferenceError: nope is not defined' })
    }
    res.statusCode = 404
    reply(res, { error: 'unknown command', message: req.url })
  })
}).listen(port, '127.0.0.1')
`

function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function makeContext(overrides = {}) {
  const tmp = mkdtempSync(join(root, 'tmp-'))
  const lines = { out: [], err: [] }
  const purged = []
  const port = await freePort()
  return {
    tmp,
    lines,
    purged,
    port,
    ctx: {
      tmp,
      env: {
        ...process.env,
        TMPDIR: tmp,
        TEMP: tmp,
        MEMRY_AGENT_BINARY: fakeBinary,
        TAURI_WEBDRIVER_PORT: String(port),
        ...overrides
      },
      purgeKeychain: (device) => purged.push(device),
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line)
    }
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-app-test-'))
  fakeBinary = join(root, 'fake-memry-tauri.mjs')
  writeFileSync(fakeBinary, FAKE_APP)
  chmodSync(fakeBinary, 0o755)
})

after(() => rmSync(root, { recursive: true, force: true }))

let running
afterEach(async () => {
  if (running) await main(['stop'], running)
  running = undefined
})

describe('agent-app', () => {
  it('start writes the control file, spawns with the gate and port, and stop removes everything', async () => {
    const { ctx, tmp, lines, purged, port } = await makeContext()
    running = ctx

    assert.equal(await main(['start'], ctx), 0, lines.err.join('\n'))
    const control = JSON.parse(readFileSync(join(tmp, 'memry-e2e', `control-${port}.json`), 'utf8'))
    assert.match(control.device, /^e2e-agent-/)
    assert.equal(control.extraEnv && Object.keys(control.extraEnv).length, 0)
    assert.ok(existsSync(join(control.testVaultPath, 'notes')), 'a copy of the test vault')
    assert.deepEqual(JSON.parse(readFileSync(join(control.appDataDir, 'env.json'), 'utf8')), {
      MEMRY_E2E: '1',
      port
    })
    assert.ok(lines.out.some((line) => line.includes(`http://127.0.0.1:${port}`)))
    assert.ok(lines.out.some((line) => line.endsWith(join('logs', 'main.log'))))

    const state = JSON.parse(readFileSync(join(tmp, 'memry-agent-app-tauri.json'), 'utf8'))
    assert.equal(state.deviceId, control.device)

    lines.out.length = 0
    assert.equal(await main(['stop'], ctx), 0)
    running = undefined
    assert.deepEqual(lines.out, ['Stopped and cleaned up.'])
    assert.deepEqual(purged, [control.device])
    assert.deepEqual(
      readdirSync(tmp).filter((name) => name.startsWith('memry-agent')),
      []
    )
    assert.equal(existsSync(join(tmp, 'memry-e2e', `control-${port}.json`)), false)
  })

  it('refuses a second instance', async () => {
    const { ctx, lines } = await makeContext()
    running = ctx
    assert.equal(await main(['start'], ctx), 0)
    lines.out.length = 0
    assert.equal(await main(['start'], ctx), 0)
    assert.match(lines.out[0], /^Already running/)
  })

  it('first run opens no vault', async () => {
    const { ctx, tmp, port } = await makeContext({ MEMRY_AGENT_FIRST_RUN: '1' })
    running = ctx
    assert.equal(await main(['start'], ctx), 0)
    const control = JSON.parse(readFileSync(join(tmp, 'memry-e2e', `control-${port}.json`), 'utf8'))
    assert.equal(control.testVaultPath, null)
  })

  it('names the build command when the binary is missing', async () => {
    const { ctx, lines, tmp } = await makeContext({ MEMRY_AGENT_BINARY: join(root, 'absent') })
    assert.equal(await main(['start'], ctx), 1)
    assert.match(lines.err[0], /Build it first: pnpm --filter @memry\/desktop-tauri build:e2e/)
    assert.deepEqual(readdirSync(tmp), [], 'nothing is created')
  })

  it('stop without state prints Not running', async () => {
    const { ctx, lines } = await makeContext()
    assert.equal(await main(['stop'], ctx), 0)
    assert.deepEqual(lines.out, ['Not running.'])
  })

  it('eval prints strings raw, other values as JSON and errors on stderr with exit 1', async () => {
    const { ctx, lines } = await makeContext()
    running = ctx
    assert.equal(await main(['start'], ctx), 0)
    lines.out.length = 0

    assert.equal(await main(['eval', 'document.title'], ctx), 0)
    assert.equal(await main(['eval', '1', '+', '1'], ctx), 0)
    assert.deepEqual(lines.out.slice(0, 2), ['MemryNote', '2'])

    // Statements are not an expression; the script runs them as a function body.
    assert.equal(await main(['eval', 'const a = 3; return a'], ctx), 0)
    assert.equal(lines.out.at(-1), '3')

    assert.equal(await main(['eval', 'nope'], ctx), 1)
    assert.match(lines.err.at(-1), /ReferenceError/)
  })

  it('shot writes the PNG bytes', async () => {
    const { ctx, tmp } = await makeContext()
    running = ctx
    assert.equal(await main(['start'], ctx), 0)
    const file = join(tmp, 'agent.png')
    assert.equal(await main(['shot', file], ctx), 0)
    assert.equal(readFileSync(file, 'utf8'), 'PNG')
  })

  it('start fails and cleans up when the app exits during startup', async () => {
    const dead = join(root, 'dead.mjs')
    writeFileSync(dead, '#!/usr/bin/env node\nprocess.exit(3)\n')
    chmodSync(dead, 0o755)
    const { ctx, lines, tmp, purged } = await makeContext({ MEMRY_AGENT_BINARY: dead })
    assert.equal(await main(['start'], ctx), 1)
    assert.match(lines.err.join('\n'), /exited during startup/)
    assert.equal(purged.length, 1)
    assert.deepEqual(
      readdirSync(tmp).filter((name) => name.startsWith('memry-agent')),
      []
    )
  })
})
