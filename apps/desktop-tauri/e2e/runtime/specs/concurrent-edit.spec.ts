import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  withRuntimeDriver,
  type RuntimeBrowser,
  type RuntimeScenario
} from '../helpers/driver'
import { invokeRuntimeCommand } from '../helpers/devtools'

export const scenarios: RuntimeScenario[] = [
  {
    name: 'CRDT snapshots converge across device origins',
    device: 'concurrent-a',
    originTag: '1001',
    run: async ({ browser: browserA, appPath, vault }) => {
      const noteId = vault.seed.notes[0]!.id
      const updateA = makeTextUpdate('device-a')
      const updateB = makeTextUpdate('device-b')

      await invokeRuntimeCommand(browserA, 'crdt_open_doc', { noteId })
      await invokeRuntimeCommand(browserA, 'crdt_apply_update', {
        input: { noteId, update: updateA, origin: 1001 }
      })
      await invokeRuntimeCommand(browserA, 'crdt_apply_update', {
        input: { noteId, update: updateB, origin: 2002 }
      })

      await withRuntimeDriver(
        { appPath, device: 'concurrent-b', originTag: '2002' },
        async ({ browser: browserB }) => {
          await invokeRuntimeCommand(browserB, 'devtools_open_test_vault', { root: vault.root })
          await invokeRuntimeCommand(browserB, 'devtools_seed_vault', { root: vault.root })
          await invokeRuntimeCommand(browserB, 'crdt_open_doc', { noteId })
          await invokeRuntimeCommand(browserB, 'crdt_apply_update', {
            input: { noteId, update: updateB, origin: 2002 }
          })
          await invokeRuntimeCommand(browserB, 'crdt_apply_update', {
            input: { noteId, update: updateA, origin: 1001 }
          })

          const [snapshotA, snapshotB] = await Promise.all([
            snapshot(browserA, noteId),
            snapshot(browserB, noteId)
          ])
          assert.deepEqual(snapshotA, snapshotB, 'CRDT snapshots diverged')

          const [visibleA, visibleB] = await Promise.all([
            visibleEditorText(browserA, vault.seed.notes[0]!.title),
            visibleEditorText(browserB, vault.seed.notes[0]!.title)
          ])
          assert.equal(visibleA, visibleB, 'visible editor text diverged')
        }
      )
    }
  }
]

function makeTextUpdate(text: string): number[] {
  const doc = new Y.Doc()
  doc.getText('runtime-convergence').insert(0, text)
  return Array.from(Y.encodeStateAsUpdate(doc))
}

async function snapshot(browser: RuntimeBrowser, noteId: string): Promise<number[]> {
  const value = await invokeRuntimeCommand<unknown>(browser, 'crdt_get_snapshot', { noteId })
  if (Array.isArray(value)) return value as number[]
  if (value instanceof Uint8Array) return Array.from(value)
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  if (value && typeof value === 'object' && 'bytes' in value) {
    return Array.from((value as { bytes: number[] }).bytes)
  }
  throw new Error(`Unsupported snapshot payload: ${String(value)}`)
}

async function visibleEditorText(browser: RuntimeBrowser, title: string): Promise<string> {
  await clickText(browser, title)
  await browser.$('.bn-editor').waitForDisplayed({ timeout: 15_000 })
  return browser.$('.bn-editor').getText()
}

async function clickText(browser: RuntimeBrowser, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((label) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          if (node.textContent?.trim() === label) {
            const element = node.parentElement as HTMLElement | null
            element?.click()
            return true
          }
          node = walker.nextNode()
        }
        return false
      }, text),
    { timeout: 15_000, timeoutMsg: `Could not find seeded note ${text}` }
  )
}
