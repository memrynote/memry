// Inline AI end to end against a fake OpenAI-compatible server in the spec process (Step 22,
// #3539). The renderer runs the AI SDK and sends every provider request through
// `ai_provider_request`; Rust adds the stored key. The server checks that the key arrives, and
// an IPC recorder in the page checks that no message from Rust to the renderer ever carries it.
// The issue names `e2e/ai-inline.e2e.ts`; the wdio glob runs `e2e/specs/**`, so it lives here.
import { randomUUID } from 'node:crypto'
import * as http from 'node:http'

import { blockText, editorDocument, openNewNote, type EditorBlock } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const ORIGINAL = 'rough paragraph for the ai rewrite'
const SUMMARY = 'Short summary from the fake model'
const DISCARDED = 'Discarded rewrite never kept'
const MASKED_KEY = '\u2022'.repeat(8)
// Not an `sk-` literal: the repo secret scanner flags one even in tests.
const API_KEY = `e2e-ai-key-${randomUUID()}`

interface SeenRequest {
  path: string
  /** The `authorization` header is exactly the stored key. Never the header itself. */
  authorized: boolean
  /** The renderer's placeholder key reached the provider. */
  placeholder: boolean
  /** The request carries the selected text. */
  hasSelection: boolean
  /** The client closed the request before the answer ended. */
  closedEarly: boolean
}

/** What the next request gets: a tool call that rewrites `blockId`, or a head and no end. */
let script: { kind: 'rewrite'; blockId: string; text: string } | { kind: 'hold' } = {
  kind: 'hold'
}
const seen: SeenRequest[] = []

const sse = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`
const completionChunk = (delta: unknown, finish: string | null) => ({
  id: 'chatcmpl-e2e',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'e2e-ai',
  choices: [{ index: 0, delta, finish_reason: finish }]
})

function rewrite(blockId: string, text: string): string {
  const operations = [{ type: 'update', id: `${blockId}$`, block: `<p>${text}</p>` }]
  return (
    sse(
      completionChunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_e2e',
              type: 'function',
              function: {
                name: 'applyDocumentOperations',
                arguments: JSON.stringify({ operations })
              }
            }
          ]
        },
        null
      )
    ) +
    sse(completionChunk({}, 'tool_calls')) +
    'data: [DONE]\n\n'
  )
}

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const auth = request.headers.authorization ?? ''
    const entry: SeenRequest = {
      path: new URL(request.url ?? '/', 'http://fake.invalid').pathname,
      authorized: auth === `Bearer ${API_KEY}`,
      placeholder: auth.includes('memry-ai-proxy'),
      hasSelection: body.includes(ORIGINAL),
      closedEarly: false
    }
    seen.push(entry)
    response.on('close', () => {
      if (!response.writableEnded) entry.closedEarly = true
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (script.kind === 'rewrite') {
      response.end(rewrite(script.blockId, script.text))
    } else {
      // The head goes out at once; the body never ends, so only a cancel closes the request.
      response.flushHeaders()
    }
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface AiEditor {
  document: EditorBlock[]
  getExtension?(name: string): { abort(): Promise<void> } | null
}

declare global {
  interface Window {
    __memryAiEditor?: AiEditor
    __memryIpcSeen?: Array<{ out: boolean; cmd: string; text: string }>
  }
}

/**
 * Records every IPC message in both directions: requests at `fetch` of the `ipc` protocol, and
 * answers, channel frames and events where Rust's reply reaches `runCallback`.
 */
const recordIpc = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seenIpc: NonNullable<Window['__memryIpcSeen']> = []
    window.__memryIpcSeen = seenIpc
    const decoder = new TextDecoder()
    const text = (value: unknown): string => {
      if (typeof value === 'string') return value
      if (value instanceof ArrayBuffer) return decoder.decode(value)
      if (ArrayBuffer.isView(value)) return decoder.decode(value)
      return JSON.stringify(value) ?? ''
    }
    const realFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith('ipc://') || url.includes('ipc.localhost')) {
        seenIpc.push({ out: true, cmd: url.split('/').pop() ?? '', text: text(init?.body) })
      }
      return realFetch(input, init)
    }
    const callbacks = (
      window.__TAURI_INTERNALS__ as unknown as {
        callbacks: Map<number, (data: unknown) => void>
      }
    ).callbacks
    const get = callbacks.get.bind(callbacks)
    callbacks.get = (id) => {
      const callback = get(id)
      return (
        callback &&
        ((data: unknown) => {
          seenIpc.push({ out: false, cmd: '', text: text(data) })
          callback(data)
        })
      )
    }
  })

/** Where the key shows up in the recorded IPC, without returning the key. */
const keySightings = (page: Page) =>
  page.evaluate((key: string) => {
    const all = window.__memryIpcSeen ?? []
    return {
      toRenderer: all.filter((entry) => !entry.out && entry.text.includes(key)).length,
      fromRenderer: all.filter((entry) => entry.out && entry.text.includes(key)).map((e) => e.cmd),
      providerRequests: all.filter((entry) => entry.out && entry.cmd === 'ai_provider_request')
        .length,
      answers: all.filter((entry) => !entry.out).length
    }
  }, API_KEY)

/** Opens a note with one paragraph, configured for the fake server, and returns its block id. */
async function openConfiguredNote(page: Page, title: string): Promise<string> {
  await vaultOpen(page)
  await recordIpc(page)
  await invoke(page, 'ai_inline_set_settings', {
    updates: { enabled: true, provider: 'custom', model: 'e2e-ai', apiKey: API_KEY, baseUrl }
  })
  const settings = await invoke<{ apiKey: string }>(page, 'ai_inline_get_settings')
  expect(settings.apiKey === MASKED_KEY).toBe(true)

  await openNewNote(page, `${title} ${Date.now().toString(36)}`, ORIGINAL)
  await page.locator(NOTE_EDITOR).first().click()
  // The editor is kept: `__memryActiveEditor` is unset while the AI menu holds the focus.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const editor = (window as unknown as { __memryActiveEditor?: AiEditor }).__memryActiveEditor
        window.__memryAiEditor = editor
        return Boolean(editor?.getExtension?.('ai'))
      })
    )
    .toBe(true)
  const [block] = await editorDocument(page)
  if (!block) throw new Error('the note has no block')
  return block.id
}

async function summarizeSelection(page: Page, text: string): Promise<void> {
  // Triple-click selects the paragraph's text, which shows the selection commands. Cmd/Ctrl+A
  // selects the blocks, and the menu offers BlockNote's add-only Summarize instead.
  await page.locator(NOTE_EDITOR).first().getByText(text).click({ clickCount: 3 })
  await page.keyboard.press(`${MOD}+j`)
  await expect(page.getByText('Summarize').first()).toBeVisible()
  await page.getByText('Summarize').first().click()
}

const firstText = async (page: Page): Promise<string> => {
  const [block] = await page.evaluate(() => window.__memryAiEditor?.document ?? [])
  return block ? blockText(block) : ''
}

test('a menu action streams a diff from the stored-key provider; Accept applies, Revert discards', async ({
  page
}) => {
  const blockId = await openConfiguredNote(page, 'AI Inline')
  const before = seen.length

  script = { kind: 'rewrite', blockId, text: SUMMARY }
  await summarizeSelection(page, ORIGINAL)
  await expect(page.getByText('Accept').first()).toBeVisible({ timeout: 30_000 })
  await page.getByText('Accept').first().click()
  await expect.poll(() => firstText(page)).toBe(SUMMARY)

  const accepted = seen.slice(before)
  expect(accepted.map((request) => request.path)).toEqual(['/v1/chat/completions'])
  expect(
    accepted.map(({ authorized, placeholder, hasSelection }) => ({
      authorized,
      placeholder,
      hasSelection
    }))
  ).toEqual([{ authorized: true, placeholder: false, hasSelection: true }])

  // A second rewrite, shown as a suggestion and discarded: the paragraph keeps the accepted text.
  script = { kind: 'rewrite', blockId, text: DISCARDED }
  await summarizeSelection(page, SUMMARY)
  await expect(page.getByText('Revert').first()).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('[aria-label="Rich text editor"] ins')]
          .map((inserted) => inserted.textContent)
          .join('')
      )
    )
    .toBe(DISCARDED)
  await page.getByText('Revert').first().click()
  await expect(page.getByText('Revert').first()).toBeHidden()
  expect(await firstText(page)).toBe(SUMMARY)
  expect(seen.length - before).toBe(2)

  // The key went out once, in the save; nothing Rust sent back carried it.
  const sightings = await keySightings(page)
  expect(sightings.fromRenderer).toEqual(['ai_inline_set_settings'])
  expect(sightings.toRenderer).toBe(0)
  expect(sightings.providerRequests).toBe(2)
  expect(sightings.answers).toBeGreaterThan(0)
})

test('cancelling a running request closes the upstream connection', async ({ page }) => {
  await openConfiguredNote(page, 'AI Cancel')
  const before = seen.length

  script = { kind: 'hold' }
  await summarizeSelection(page, ORIGINAL)
  await expect.poll(() => seen.length - before, { timeout: 30_000 }).toBe(1)
  const held = seen[before]
  expect(held?.authorized).toBe(true)
  expect(held?.closedEarly).toBe(false)

  // BlockNote 0.54 shows no stop button while it waits; `abort` is the extension's cancel.
  await page.evaluate(() => window.__memryAiEditor?.getExtension?.('ai')?.abort())
  await expect.poll(() => held?.closedEarly, { timeout: 15_000 }).toBe(true)
  expect(await firstText(page)).toBe(ORIGINAL)
  expect((await keySightings(page)).toRenderer).toBe(0)
})
