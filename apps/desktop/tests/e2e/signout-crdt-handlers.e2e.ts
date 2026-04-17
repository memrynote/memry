/**
 * Regression test for the signout CRDT handler race.
 *
 * History: on logout, SessionTeardown used to destroy the CrdtProvider which
 * unregistered all `crdt:*` IPC handlers. React cleanup for `useYjsCollaboration`
 * fires AFTER main-process teardown (cross-process race), so the renderer's
 * `closeDoc` call landed on a gone handler and Electron logged:
 *   `Error occurred in handler for 'crdt:close-doc': No handler registered ...`
 *
 * Fix: handlers are now registered once at app bootstrap and resolve the
 * provider via `getCrdtProvider()` on every invocation. Destroy no longer
 * removes handlers.
 *
 * This test simulates the exact race by:
 *  1. invoking `openDoc` to force provider init and push renderer state
 *  2. triggering teardown via the test-only hook (mirrors SessionTeardown)
 *  3. invoking `closeDoc` AFTER teardown (the race)
 *  4. asserting both IPC calls returned success and no handler-missing error
 *     appeared in main-process logs
 */
import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'
import type { LaunchedElectron } from './utils/electron-lifecycle'

function getMainLogs(app: ElectronApplication): string[] {
  const launched = (app as unknown as { __launched?: LaunchedElectron }).__launched
  if (!launched) throw new Error('Electron app launched state missing — fixture wiring broke')
  return launched.mainLogs
}

const HANDLER_MISSING_PATTERN = /No handler registered for 'crdt:/i

test('signout/teardown does not remove CRDT IPC handlers', async ({ electronApp, page }) => {
  // #given — a note exists so openDoc is valid
  const noteId = await page.evaluate(async () => {
    const result = await window.api.notes.create({ title: 'signout-crdt-test', content: '' })
    if (!result.success || !result.note) throw new Error(result.error || 'failed to create note')
    return result.note.id
  })

  // Force CRDT provider init + registered note open
  await page.evaluate(async (id) => {
    await window.api.syncCrdt.openDoc({ noteId: id })
  }, noteId)

  const logsBefore = getMainLogs(electronApp).length

  // #when — simulate the exact teardown sequence that happens on logout
  await electronApp.evaluate(async () => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: { simulateCrdtTeardownForTests(): Promise<void> }
      }
    ).__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    await hooks.simulateCrdtTeardownForTests()
  })

  // #when — renderer cleanup fires a late closeDoc (the bug trigger)
  const closeResult = await page.evaluate(async (id) => {
    try {
      const r = await window.api.syncCrdt.closeDoc({ noteId: id })
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, noteId)

  // #then — IPC succeeded (handler still alive)
  expect(closeResult.ok).toBe(true)
  expect(closeResult.result).toEqual({ success: true })

  // #then — no "No handler registered" error appeared in main-process log stream
  const newLogs = getMainLogs(electronApp).slice(logsBefore)
  const offenders = newLogs.filter((line) => HANDLER_MISSING_PATTERN.test(line))
  expect(offenders, `Unexpected handler-missing errors:\n${offenders.join('\n')}`).toEqual([])
})
