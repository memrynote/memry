import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { startFakeWebDriver } from './lib/fake-webdriver.mjs'
import { ELEMENT_KEY } from './lib/webdriver-client.mjs'

const SERVER = fileURLToPath(new URL('./webdriver-mcp.mjs', import.meta.url))
const OUTLINE = {
  lines: ['- button "Save" [ref=e1]', '- textbox "Title" value="Hi" [ref=e2]'],
  total: 2,
  truncated: false
}

let dir
let fake
let client

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webdriver-mcp-test-'))
  fake = await startFakeWebDriver((method, path, body) => {
    if (path === '/session' && method === 'POST') return { sessionId: 'mcp-session' }
    if (path === '/session/mcp-session' && method === 'DELETE') return null
    if (path === '/session/mcp-session/execute/sync') {
      return body.script.includes('snapshotPage') ? OUTLINE : null
    }
    if (path === '/session/mcp-session/execute/async') return { ok: true, value: 'MemryNote' }
    if (path === '/session/mcp-session/element') {
      return body.value === '[data-agent-ref="e1"]'
        ? { [ELEMENT_KEY]: 'el-1' }
        : { status: 404, value: { error: 'no such element', message: 'no match' } }
    }
    if (path === '/session/mcp-session/element/el-1/rect')
      return { x: 10, y: 20, width: 100, height: 40 }
    if (path === '/session/mcp-session/screenshot') return Buffer.from('PNG').toString('base64')
    if (path === '/session/mcp-session/window') return 'main'
    if (path === '/session/mcp-session/window/handles') return ['main']
    return null
  })
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        MEMRY_WEBDRIVER_URL: fake.url,
        MEMRY_AGENT_SCREENSHOT_DIR: dir,
        TMPDIR: dir,
        TEMP: dir
      }
    })
  )
})

after(async () => {
  await client.close()
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (name, args = {}) => client.callTool({ name, arguments: args })

describe('webdriver-mcp', () => {
  it('lists the Playwright-style tools', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [
      'browser_click',
      'browser_evaluate',
      'browser_press_key',
      'browser_snapshot',
      'browser_tabs',
      'browser_take_screenshot',
      'browser_type',
      'browser_wait_for'
    ])
  })

  it('snapshot returns the outline from one execute call', async () => {
    const result = await call('browser_snapshot')
    assert.equal(result.content[0].text, OUTLINE.lines.join('\n'))
    assert.equal(fake.requests.filter((r) => r.path.endsWith('/execute/sync')).length, 1)
  })

  it('click maps a ref to an Actions request at the element center', async () => {
    const result = await call('browser_click', { ref: 'e1' })
    assert.equal(result.isError, undefined)
    const actions = fake.requests.find((r) => r.path.endsWith('/actions') && r.method === 'POST')
    assert.deepEqual(actions.body.actions[0].actions, [
      { type: 'pointerMove', duration: 0, x: 60, y: 40, origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 }
    ])
  })

  it('a stale ref tells the agent to take a new snapshot', async () => {
    const result = await call('browser_click', { ref: 'e9' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Take a new browser_snapshot/)
  })

  it('evaluate answers the value and screenshot writes a PNG', async () => {
    assert.equal(
      (await call('browser_evaluate', { script: 'document.title' })).content[0].text,
      'MemryNote'
    )
    const file = join(dir, 'out.png')
    const shot = await call('browser_take_screenshot', { path: file })
    assert.equal(shot.content[0].text, file)
    assert.equal(readFileSync(file, 'utf8'), 'PNG')
  })

  it('opens one session and deletes it on exit', async () => {
    const opened = fake.requests.filter((r) => r.path === '/session' && r.method === 'POST')
    assert.equal(opened.length, 1)
    await client.close()
    await new Promise((done) => setTimeout(done, 300))
    assert.ok(fake.requests.some((r) => r.method === 'DELETE' && r.path === '/session/mcp-session'))
  })
})

describe('webdriver-mcp session reuse', () => {
  it('reuses the session the agent state file holds for the same port', async () => {
    const seen = await startFakeWebDriver((method, path) => {
      if (path.endsWith('/window/handles')) return ['main']
      if (path.endsWith('/execute/sync')) return OUTLINE
      return null
    })
    writeFileSync(
      join(dir, 'memry-agent-app-tauri.json'),
      JSON.stringify({ port: seen.port, sessionId: 'agent-session' })
    )
    const second = new Client({ name: 'test', version: '0.0.0' })
    await second.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env, MEMRY_WEBDRIVER_URL: seen.url, TMPDIR: dir, TEMP: dir }
      })
    )
    await second.callTool({ name: 'browser_snapshot', arguments: {} })
    await second.close()
    await seen.close()
    assert.equal(
      seen.requests.some((r) => r.path === '/session' && r.method === 'POST'),
      false
    )
    assert.ok(seen.requests.some((r) => r.path === '/session/agent-session/execute/sync'))
  })
})
