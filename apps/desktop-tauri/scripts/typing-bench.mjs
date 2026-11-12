#!/usr/bin/env node
// Typing latency of the Tauri app against the Electron app on the same vault and note (#3531,
// "Concurrency and performance": typing not slower than Electron on the same machine).
//
//   pnpm --filter @memry/desktop-tauri build:e2e             # or a release e2e build, below
//   pnpm --filter @memry/desktop exec electron-vite build
//   node apps/desktop-tauri/scripts/typing-bench.mjs [--app both|tauri|electron] [--keys 300]
//
// Each app starts through its own `agent-app.mjs` sandbox (temp profile, `e2e-agent-*` device,
// a copy of the bench vault) on port 9222, one after the other. The vault holds a short note and
// a long note of 5000 blocks. In each note the caret goes to the end of the first paragraph, and
// the page types one character at a time with the browser's `insertText` command, the way the
// e2e harness types (WebDriver's key actions put no text into a contenteditable). A key's
// latency runs from the command to the end of the first frame after the editor's DOM changed
// (`requestAnimationFrame`, then a task): what a user sees as the character painted. "Handled"
// stops after the command and one task: the editor's own work, without the wait for a frame. Keys are
// `--gap` ms apart, a typist's pace. The loop runs inside the page, so the driver's transport
// (WebDriver for Tauri, CDP for Electron) is not in the numbers.
//
// MEMRY_AGENT_BINARY=<path> picks the Tauri binary, as for agent-app.mjs; a release e2e build is
// `tauri build --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { createClient } from './lib/webdriver-client.mjs'

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PORT = 9222
const CHUNK = 50
const LONG_BLOCKS = 5000
const EVALUATE_TIMEOUT_MS = 180_000

export const NOTES = [
  { file: 'typing-bench-plain', title: 'Typing bench plain', blocks: 3 },
  { file: 'typing-bench-long', title: 'Typing bench long', blocks: LONG_BLOCKS }
]

// Neither app reads a frontmatter `id`: the file path is the note's identity, and each app
// indexes it under its own id. So the bench asks the app's read-only debug query for the id of
// the note's path.
const APPS = {
  tauri: {
    script: join(REPO, 'apps/desktop-tauri/scripts/agent-app.mjs'),
    connect: connectWebDriver,
    idQuery: (path) => ['query', `SELECT note_id AS id FROM note_files WHERE path = '${path}'`]
  },
  electron: {
    script: join(REPO, 'apps/desktop/scripts/agent-app.mjs'),
    connect: connectCdp,
    idQuery: (path) => [
      'eval',
      `__memryDebug.indexQuery("SELECT id FROM note_cache WHERE path = '${path}'")`
    ]
  }
}

/** One block of a bench note; the first is the paragraph the caret goes to. */
export function block(n) {
  if (n === 0) return 'Typing starts at the end of this line'
  if (n % 10 === 0) return `## Section ${n}`
  if (n % 10 === 3 || n % 10 === 4) return `- list item ${n} with a few words and a [[Wiki Link]]`
  return `Paragraph ${n} with **bold**, *italic*, \`code\` and a [link](https://example.com/${n}), long enough to wrap.`
}

export function noteMarkdown({ title, blocks }) {
  const body = Array.from({ length: blocks }, (_, n) => block(n)).join('\n\n')
  return `---\ntitle: '${title}'\n---\n\n${body}\n`
}

export function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
}

export function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]
  }
}

function makeVault() {
  const vault = mkdtempSync(join(tmpdir(), 'memry-typing-bench-'))
  mkdirSync(join(vault, 'notes'))
  for (const note of NOTES)
    writeFileSync(join(vault, 'notes', `${note.file}.md`), noteMarkdown(note))
  return vault
}

/**
 * Throws when `agent-app.mjs status` reports a live sandbox. `start` exits 0 with "Already
 * running" and the bench's `stop` would then end another session's app and its vault.
 */
export function assertNoRunningSandbox(app, statusOutput) {
  const text = statusOutput.trim()
  if (!text.startsWith('{')) return
  const state = JSON.parse(text)
  if (state.alive) {
    throw new Error(`${app} agent-app already runs (pid ${state.pid}); stop it before the bench`)
  }
}

function agent(app, args, env = {}) {
  const command = args[0]
  const run = spawnSync(process.execPath, [APPS[app].script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000
  })
  if (run.status !== 0) {
    throw new Error(`${app} agent-app ${command} exited ${run.status}: ${run.stderr.slice(-600)}`)
  }
  return run.stdout
}

/** The app's id of the note at `path`, once the app has indexed it. */
async function noteId(app, path) {
  const deadline = Date.now() + 120_000
  for (;;) {
    // Electron's debug handle answers `undefined` until its vault is open.
    const out = agent(app, APPS[app].idQuery(path)).trim()
    const id = out.startsWith('[') ? JSON.parse(out)[0]?.id : undefined
    if (id) return id
    if (Date.now() > deadline) throw new Error(`${app} never indexed ${path}`)
    await new Promise((done) => setTimeout(done, 1_000))
  }
}

/** `evaluate(fnSource, arg)` runs `(fnSource)(arg)` in the Tauri page and resolves its result. */
async function connectWebDriver() {
  const state = JSON.parse(readFileSync(join(tmpdir(), 'memry-agent-app-tauri.json'), 'utf8'))
  // The port and session id come from agent-app's state file and end up in a request to
  // localhost; check their shape so a changed file cannot steer the request elsewhere.
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65_535) {
    throw new Error('agent-app state file has no valid port')
  }
  if (state.sessionId !== undefined && !/^[\w-]+$/.test(state.sessionId)) {
    throw new Error('agent-app state file has no valid session id')
  }
  const client = createClient(`http://127.0.0.1:${state.port}`)
  const session = state.sessionId ?? (await client.newSession())
  await fetch(`${client.baseUrl}/session/${session}/timeouts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: 120_000 })
  })
  const script = `const done = arguments[arguments.length - 1];
    Promise.resolve((FN)(arguments[0])).then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error: String(error && error.message || error) }))`
  return {
    async evaluate(fn, arg) {
      const reply = await client.executeAsync(session, script.replace('FN', fn), [arg])
      if (!reply?.ok) throw new Error(reply?.error ?? 'no reply')
      return reply.value
    },
    close: () => undefined
  }
}

async function connectCdp() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!list.ok) throw new Error(`CDP /json/list answered ${list.status}`)
  const targets = await list.json()
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  if (!page) throw new Error('no renderer page on CDP')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', fail, { once: true })
  })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', (message) => {
    const reply = JSON.parse(message.data)
    const settle = pending.get(reply.id)
    pending.delete(reply.id)
    if (typeof settle?.resolve === 'function') settle.resolve(reply)
  })
  socket.addEventListener('close', () => {
    for (const settle of pending.values()) settle.reject(new Error('the CDP socket closed'))
    pending.clear()
  })
  return {
    async evaluate(fn, arg) {
      const id = ++next
      const reply = await new Promise((succeed, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          fail(new Error(`CDP evaluate timed out after ${EVALUATE_TIMEOUT_MS} ms`))
        }, EVALUATE_TIMEOUT_MS)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            succeed(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression: `(${fn})(${JSON.stringify(arg)})`,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true
            }
          })
        )
      })
      const thrown = reply.result?.exceptionDetails
      if (reply.error || thrown) {
        throw new Error(JSON.stringify(reply.error ?? thrown.exception?.description ?? thrown))
      }
      return reply.result.result.value
    },
    close: () => socket.close()
  }
}

// Page functions: plain source, run in the app's renderer.

/** Opens the note's tab and puts the caret at the end of its first paragraph. */
const OPEN_NOTE = String(async ({ id, title, first }) => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the function body is serialized into the page, so every helper lives inside it
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const deadline = performance.now() + 60_000
  for (;;) {
    window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail: { id, title } }))
    await sleep(500)
    const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    const editor = editors.find((e) => e.offsetParent !== null && e.textContent.includes(first))
    if (editor) {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode()) && !node.data.includes(first));
      if (!node) throw new Error('first paragraph not found')
      editor.focus()
      const range = document.createRange()
      range.setStart(node, node.data.length)
      range.collapse(true)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return { blocks: editor.querySelectorAll('[data-node-type="blockContainer"]').length }
    }
    if (performance.now() > deadline) throw new Error(`note ${id} did not open`)
  }
})

/** Types `count` characters `gap` ms apart; resolves each one's latency in ms. */
const TYPE_KEYS = String(async ({ count, gap, first }) => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the function body is serialized into the page, so every helper lives inside it
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the function body is serialized into the page, so every helper lives inside it
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()))
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the function body is serialized into the page, so every helper lives inside it
  const task = () =>
    new Promise((done) => {
      const channel = new MessageChannel()
      channel.port1.addEventListener('message', () => done())
      channel.port1.start()
      channel.port2.postMessage(0)
    })
  const editor = document.activeElement?.closest('.ProseMirror')
  if (!editor) throw new Error('the editor lost focus')
  const line = () => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && !node.data.startsWith(first.slice(0, 12)));
    return node?.data.length ?? -1
  }
  const before = line()
  const latencies = []
  const handled = []
  const letters = 'abcdefghijklmnopqrstuvwxyz '
  for (let i = 0; i < count; i++) {
    await sleep(gap)
    let changed = false
    const observer = new MutationObserver(() => (changed = true))
    observer.observe(editor, { subtree: true, childList: true, characterData: true })
    const start = performance.now()
    // oxlint-disable-next-line typescript/no-deprecated -- the browser's own text insertion, as the e2e harness types (pw-compat/page.ts)
    document.execCommand('insertText', false, letters[i % letters.length])
    await task()
    handled.push(performance.now() - start)
    let painted = Infinity
    for (let f = 0; f < 120; f++) {
      await frame()
      await task()
      if (changed) {
        painted = performance.now()
        break
      }
    }
    observer.disconnect()
    latencies.push(painted - start)
  }
  return { latencies, handled, grew: line() - before }
})

async function benchApp(app, vault, keys, gap) {
  assertNoRunningSandbox(app, agent(app, ['status']))
  let page
  const results = {}
  try {
    agent(app, ['start'], { MEMRY_AGENT_VAULT_TEMPLATE: vault })
    page = await APPS[app].connect()
    for (const note of NOTES) {
      const first = block(0)
      const id = await noteId(app, `notes/${note.file}.md`)
      const opened = await page.evaluate(OPEN_NOTE, { id, title: note.title, first })
      // The long note keeps rendering and indexing after it shows; typing starts once it rests.
      await new Promise((done) => setTimeout(done, note.blocks > 100 ? 5_000 : 1_000))
      const latencies = []
      const handled = []
      for (let done = 0; done < keys; done += CHUNK) {
        const count = Math.min(CHUNK, keys - done)
        const typed = await page.evaluate(TYPE_KEYS, { count, gap, first })
        if (typed.grew !== count) {
          throw new Error(`${app} ${note.file}: typed ${count} keys, the line grew ${typed.grew}`)
        }
        latencies.push(...typed.latencies)
        handled.push(...typed.handled)
      }
      results[note.file] = {
        painted: summarize(latencies),
        handled: summarize(handled),
        renderedBlocks: opened.blocks
      }
    }
  } finally {
    page?.close()
    agent(app, ['stop'])
  }
  return results
}

const ms = (v) => v.toFixed(1)

function table(results) {
  const lines = [
    '| app | note | keys | painted p50 | painted p95 | painted max | handled p50 | handled p95 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const [app, notes] of Object.entries(results)) {
    for (const [note, { painted: p, handled: h }] of Object.entries(notes)) {
      lines.push(
        `| ${app} | ${note} | ${p.n} | ${ms(p.p50)} | ${ms(p.p95)} | ${ms(p.max)} | ${ms(h.p50)} | ${ms(h.p95)} |`
      )
    }
  }
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string', default: 'both' },
      keys: { type: 'string', default: '300' },
      gap: { type: 'string', default: '50' },
      json: { type: 'string' }
    }
  })
  const apps = values.app === 'both' ? ['tauri', 'electron'] : [values.app]
  if (!apps.every((app) => app in APPS)) throw new Error(`unknown --app ${values.app}`)
  const vault = makeVault()
  const results = {}
  try {
    for (const app of apps) {
      results[app] = await benchApp(app, vault, Number(values.keys), Number(values.gap))
      console.error(`${app}: ${JSON.stringify(results[app])}`)
    }
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
  console.log(table(results))
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error)
    process.exit(1)
  })
}
