// Two windows of one app edit one note (#3531 14b-2): each window's editor is bound to the note's
// document in the core through the `crdt_*` commands, the host sends each window's edit to the
// other window's channel, and the write-back puts both edits in the file. Each window records the
// commands its page invokes, so the edits are known to travel as document updates and not as
// whole-markdown saves, which would also reach the other window by a reload.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'

import { SELECTORS } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
import { createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

interface WindowSwitcher {
  switchToWindow(handle: string): Promise<void>
}

/**
 * Records the name of every command the window's page invokes from now on. Tauri's `invoke` is
 * read-only, and it posts each call to its IPC protocol through `fetch`, at `ipc://localhost/<cmd>`
 * (`http://ipc.localhost/<cmd>` on Windows).
 */
async function recordInvokes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __memryInvoked: string[] }
    const fetch = window.fetch.bind(window)
    target.__memryInvoked = []
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (/^(ipc:\/\/localhost|https?:\/\/ipc\.localhost)\//.test(url)) {
        target.__memryInvoked.push(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)))
      }
      return fetch(input, init)
    }
  })
}

/** The window's page has loaded far enough to call commands. */
async function pageReady(page: Page): Promise<void> {
  const ready = await pollUntil(
    async () => {
      try {
        return await page.evaluate(() => typeof window.__TAURI__?.core?.invoke === 'function')
      } catch {
        return false
      }
    },
    { timeoutMs: 30_000 }
  )
  expect(ready).toBe(true)
}

/** The global Tauri API with the channel the bridge test listens on. */
interface TauriWindow {
  __TAURI__: {
    core: {
      invoke: (
        command: string,
        args?: unknown,
        options?: { headers: Record<string, string> }
      ) => Promise<unknown>
      Channel: new (onmessage?: (message: ArrayBuffer) => void) => object
    }
  }
}

const invoked = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __memryInvoked: string[] }).__memryInvoked)

test('typing in one window reaches the other window, both ways, and the file', async ({
  app,
  page,
  testVaultPath
}) => {
  const windows = app.executor as unknown as WindowSwitcher
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Two Windows ${Date.now().toString(36)}`,
    content: 'Shared body',
    folder: 'notes'
  })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await expect(editor).toContainText('Shared body')

  const second = await invokeTest<string>(app, 'e2e_create_secondary_window')
  await windows.switchToWindow(second)
  await pageReady(page)
  await vaultOpen(page)
  await openFromSidebar(page, note)
  await expect(editor).toContainText('Shared body')
  await recordInvokes(page)
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' typed in B')
  await expect.poll(() => invoked(page)).toContain('crdt_apply_update')
  expect(await invoked(page)).not.toContain('notes_update')

  await windows.switchToWindow('main')
  await expect(editor).toContainText('Shared body typed in B')
  await recordInvokes(page)
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' and in A')
  await expect.poll(() => invoked(page)).toContain('crdt_apply_update')
  expect(await invoked(page)).not.toContain('notes_update')

  await windows.switchToWindow(second)
  await expect(editor).toContainText('Shared body typed in B and in A')

  const file = join(testVaultPath, note.path)
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Shared body typed in B and in A')
})

const LATENCY_SAMPLES = 200

/** The `p`th percentile of `values`, nearest rank. */
function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

// The bridge budget of the 14b-2 plan: a 200-byte update from `crdt_apply_update` in one window
// to the other window's channel, p50 under 1 ms and p99 under 5 ms. Both pages stamp with
// `performance.timeOrigin + performance.now()`, one clock for every page of the machine. The
// numbers are printed, not asserted: a loaded runner stretches any wall-clock bound (see
// scripts/check-test-timing.mjs).
test('the bridge carries an update to the other window, timed', async ({ app, page }) => {
  const windows = app.executor as unknown as WindowSwitcher
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `Bridge ${Date.now().toString(36)}`,
    content: 'Timed',
    folder: 'notes'
  })
  const doc = new Y.Doc()
  const updates: number[][] = []
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const before = Y.encodeStateVector(doc)
    doc.getText('bridge-latency').insert(0, `${i}`.padEnd(180, '.'))
    updates.push([...Y.encodeStateAsUpdate(doc, before)])
  }
  const sizes = updates.map((update) => update.length)

  const second = await invokeTest<string>(app, 'e2e_create_secondary_window')
  await windows.switchToWindow(second)
  await pageReady(page)
  await page.evaluate(async (noteId: string) => {
    const target = window as unknown as { __memryArrivals: number[] }
    const tauri = (window as unknown as TauriWindow).__TAURI__.core
    target.__memryArrivals = []
    const channel = new tauri.Channel(() => {
      target.__memryArrivals.push(performance.timeOrigin + performance.now())
    })
    await tauri.invoke('crdt_open_doc', { noteId, onUpdate: channel })
  }, note.id)

  await windows.switchToWindow('main')
  const stamped = await page.evaluate(
    async ({ noteId, frames }: { noteId: string; frames: number[][] }) => {
      const tauri = (window as unknown as TauriWindow).__TAURI__.core
      await tauri.invoke('crdt_open_doc', { noteId, onUpdate: new tauri.Channel() })
      const headers = { 'x-memry-meta': JSON.stringify({ noteId }) }
      const stamps: Array<{ sent: number; stored: number }> = []
      for (const frame of frames) {
        const at = performance.timeOrigin + performance.now()
        await tauri.invoke('crdt_apply_update', new Uint8Array(frame), { headers })
        stamps.push({ sent: at, stored: performance.timeOrigin + performance.now() })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return stamps
    },
    { noteId: note.id, frames: updates }
  )

  await windows.switchToWindow(second)
  const arrivals = () =>
    page.evaluate(() => (window as unknown as { __memryArrivals: number[] }).__memryArrivals)
  await expect.poll(async () => (await arrivals()).length).toBe(LATENCY_SAMPLES)
  const latencies = (await arrivals()).map((at, i) => at - stamped[i].sent)
  const roundTrips = stamped.map(({ sent, stored }) => stored - sent)
  const summary = (values: number[]): string =>
    `p50 ${percentile(values, 50).toFixed(3)} ms, p99 ${percentile(values, 99).toFixed(3)} ms, ` +
    `max ${Math.max(...values).toFixed(3)} ms`
  console.log(
    `bridge latency over ${LATENCY_SAMPLES} updates of ${Math.min(...sizes)}-${Math.max(...sizes)} ` +
      `bytes: to the other window ${summary(latencies)}; the sender's round trip ` +
      summary(roundTrips)
  )
})
