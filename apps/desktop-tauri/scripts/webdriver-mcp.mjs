#!/usr/bin/env node
// A stdio MCP server that drives the Tauri app over WebDriver. It replaces the Playwright MCP
// (`playwright-memry`, CDP) for the Tauri app and keeps its tool names: browser_snapshot,
// browser_click, browser_type, browser_press_key, browser_take_screenshot, browser_evaluate,
// browser_wait_for and browser_tabs.
//
// Environment: MEMRY_WEBDRIVER_URL (default http://127.0.0.1:9222), MEMRY_WEBDRIVER_SESSION (an
// existing session, for VM tunnels) and MEMRY_AGENT_SCREENSHOT_DIR (default
// /tmp/memry-webdriver-mcp). Without a session id it reuses the session `agent-app.mjs start`
// saved when the port matches, otherwise it opens one and deletes it on exit.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Plain TypeScript with no imports, so Node strips the types; one key table for both drivers.
import { pressActions, typeActions } from '../e2e/harness/pw-compat/keys.ts'
import { asScript, evaluateInPage, snapshotPage } from './lib/page-scripts.mjs'
import { createClient, ELEMENT_KEY, WebDriverError } from './lib/webdriver-client.mjs'

const MAX_LINES = 4000
const POLL_MS = 250
/** Wraps key actions as the one keyboard input source of a WebDriver Actions request. */
const keySource = (actions) => [{ type: 'key', id: 'keyboard', actions }]
const STALE = 'The ref no longer resolves. Take a new browser_snapshot and use a ref from it.'

const text = (/** @type {string} */ value) => ({ content: [{ type: 'text', text: value }] })
const failure = (/** @type {unknown} */ error) => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
})

function outline(/** @type {{ lines: string[], total: number, truncated: boolean }} */ result) {
  const lines = [...result.lines]
  if (result.truncated)
    lines.push(`... truncated: showing ${result.lines.length} of ${result.total} elements`)
  return lines.join('\n') || '(no elements with a role)'
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.stateFile] the agent state file of `agent-app.mjs`
 */
export function createDriverServer({ env = process.env, stateFile } = {}) {
  const baseUrl = env.MEMRY_WEBDRIVER_URL ?? 'http://127.0.0.1:9222'
  const client = createClient(baseUrl)
  const shotDir = env.MEMRY_AGENT_SCREENSHOT_DIR ?? '/tmp/memry-webdriver-mcp'
  const agentState = stateFile ?? join(tmpdir(), 'memry-agent-app-tauri.json')
  /** @type {{ id: string, owned: boolean } | undefined} */
  let session

  function savedSession() {
    try {
      const state = JSON.parse(readFileSync(agentState, 'utf8'))
      return state.port === Number(new URL(baseUrl).port) ? state.sessionId : undefined
    } catch {
      return undefined
    }
  }

  async function sessionId() {
    if (session) return session.id
    const explicit = env.MEMRY_WEBDRIVER_SESSION
    if (explicit) return (session = { id: explicit, owned: false }).id
    const saved = savedSession()
    if (saved) {
      try {
        await client.windowHandles(saved)
        return (session = { id: saved, owned: false }).id
      } catch {
        // the saved session ended; open one
      }
    }
    return (session = { id: await client.newSession(), owned: true }).id
  }

  async function close() {
    if (session?.owned) await client.deleteSession(session.id).catch(() => undefined)
    session = undefined
  }

  async function snapshot() {
    const id = await sessionId()
    return client.execute(id, asScript(snapshotPage), [MAX_LINES])
  }

  /** Resolves a snapshot ref to an element id; a missing element means the page moved on. */
  async function element(/** @type {string} */ ref) {
    const id = await sessionId()
    try {
      return {
        id,
        element: await client.findElement(id, `[data-agent-ref="${ref.replace(/"/g, '')}"]`)
      }
    } catch (error) {
      if (error instanceof WebDriverError && error.error === 'no such element')
        throw new Error(STALE, { cause: error })
      throw error
    }
  }

  const server = new McpServer({ name: 'webdriver-memry', version: '1.0.0' })
  const tool = (name, description, inputSchema, run) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        return await run(args)
      } catch (error) {
        return failure(error)
      }
    })

  tool(
    'browser_snapshot',
    'Outline of the visible page: roles, names, values, states and a ref per element.',
    {},
    async () => text(outline(await snapshot()))
  )

  tool(
    'browser_click',
    'Click the element with this ref from the last browser_snapshot.',
    { ref: z.string() },
    async ({ ref }) => {
      const target = await element(ref)
      await client
        .execute(target.id, 'arguments[0].scrollIntoView({ block: "center", inline: "center" })', [
          { [ELEMENT_KEY]: target.element }
        ])
        .catch(() => undefined)
      const rect = await client.elementRect(target.id, target.element)
      await client.performActions(target.id, [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            {
              type: 'pointerMove',
              duration: 0,
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
              origin: 'viewport'
            },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 }
          ]
        }
      ])
      await client.releaseActions(target.id).catch(() => undefined)
      return text(`Clicked ${ref}.`)
    }
  )

  tool(
    'browser_type',
    'Focus the element with this ref, clear it when it is a text field, type the text, optionally press Enter.',
    { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
    async ({ ref, text: value, submit }) => {
      const target = await element(ref)
      await client.execute(
        target.id,
        `const el = arguments[0]; el.focus();
         if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
           const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
           el.dispatchEvent(new Event('input', { bubbles: true }));
         }`,
        [{ [ELEMENT_KEY]: target.element }]
      )
      await client.performActions(target.id, keySource(typeActions(value)))
      if (submit) await client.performActions(target.id, keySource(pressActions('Enter')))
      await client.releaseActions(target.id).catch(() => undefined)
      return text(`Typed into ${ref}${submit ? ' and pressed Enter' : ''}.`)
    }
  )

  tool(
    'browser_press_key',
    'Press a key or combination such as Enter, ArrowDown or Control+a.',
    { key: z.string() },
    async ({ key }) => {
      const id = await sessionId()
      await client.performActions(id, keySource(pressActions(key)))
      await client.releaseActions(id).catch(() => undefined)
      return text(`Pressed ${key}.`)
    }
  )

  tool(
    'browser_take_screenshot',
    'Save a PNG of the window, or of one element when a ref is given, and return its path.',
    { path: z.string().optional(), ref: z.string().optional() },
    async ({ path, ref }) => {
      const id = await sessionId()
      const png = ref
        ? await client.elementScreenshot(id, (await element(ref)).element)
        : await client.screenshot(id)
      const file = resolve(path ?? join(shotDir, `shot-${Date.now()}.png`))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, png)
      return {
        content: [
          { type: 'text', text: file },
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }
        ]
      }
    }
  )

  tool(
    'browser_evaluate',
    'Evaluate JavaScript in the page; a promise is awaited. Answers the value as JSON.',
    { script: z.string() },
    async ({ script }) => {
      const outcome = await evaluateInPage(client, await sessionId(), script)
      if (!outcome?.ok) throw new Error(String(outcome?.error))
      return text(
        typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value, null, 2)
      )
    }
  )

  tool(
    'browser_wait_for',
    'Wait until the snapshot contains the text, or the ref resolves.',
    {
      text: z.string().optional(),
      ref: z.string().optional(),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ text: wanted, ref, timeoutMs }) => {
      if (!wanted && !ref) throw new Error('browser_wait_for needs text or ref')
      const deadline = Date.now() + (timeoutMs ?? 10_000)
      for (;;) {
        const result = await snapshot()
        const found = wanted
          ? result.lines.some((line) => line.includes(wanted))
          : result.lines.some((line) => line.endsWith(`[ref=${ref}]`))
        if (found) return text(`Found ${wanted ? `"${wanted}"` : ref}.`)
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${wanted ? `"${wanted}"` : ref}.`)
        await new Promise((done) => setTimeout(done, POLL_MS))
      }
    }
  )

  tool(
    'browser_tabs',
    'List the app windows with their titles (action "list"), or switch to one by handle (action "select").',
    { action: z.enum(['list', 'select']).optional(), handle: z.string().optional() },
    async ({ action, handle }) => {
      const id = await sessionId()
      if (action === 'select') {
        if (!handle) throw new Error('browser_tabs select needs a handle')
        await client.switchWindow(id, handle)
        return text(`Switched to ${handle}.`)
      }
      const current = await client.currentWindow(id)
      const rows = []
      for (const candidate of await client.windowHandles(id)) {
        await client.switchWindow(id, candidate)
        const title = await client.execute(id, 'return document.title', [])
        rows.push(`- ${candidate}${candidate === current ? ' (current)' : ''}: ${title}`)
      }
      await client.switchWindow(id, current)
      return text(rows.join('\n'))
    }
  )

  return { server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, close } = createDriverServer()
  const shutdown = () => {
    void close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdin.once('end', shutdown)
  await server.connect(new StdioServerTransport())
}
