import * as Y from 'yjs'
import { BrowserWindow, ipcMain } from 'electron'
import {
  CRDT_CHANNELS,
  CrdtApplyUpdateSchema,
  CrdtCloseDocSchema,
  CrdtOpenDocSchema,
  CrdtSyncStep1Schema,
  CrdtSyncStep2Schema,
  type CrdtSyncStep1Result
} from '@memry/contracts/ipc-crdt'
import { getCrdtProvider } from '../sync/crdt-provider'
import { createLogger } from '../lib/logger'
import { trackNoteBodyEditThrottled } from '../telemetry/diagnostics'
import { createValidatedHandler } from './validate'

const log = createLogger('CrdtIpc')

let handlersRegistered = false
const windowsHookedForClose = new Set<number>()

/** Test-only: resets the idempotency guard so handlers can be re-registered. */
export function _resetCrdtIpcHandlersForTests(): void {
  handlersRegistered = false
  windowsHookedForClose.clear()
}

/**
 * Release the window's Y.Docs when it goes away.
 *
 * The renderer's crdt:close-doc invoke only fires on React unmount, so ⌘W, a
 * reload, or a renderer crash leaves the window id in the doc's windowIds set
 * forever — pinning the doc and disabling eviction and compaction with it.
 *
 * One listener per WINDOW, not per doc: a window that opens dozens of notes
 * would otherwise stack a listener each time and trip Electron's max-listeners
 * warning. The id is captured now because `win.id` is not safe to read once the
 * window is destroyed.
 */
function hookWindowClose(win: BrowserWindow): void {
  const windowId = win.id
  if (windowsHookedForClose.has(windowId)) return
  windowsHookedForClose.add(windowId)
  win.once('closed', () => {
    windowsHookedForClose.delete(windowId)
    void getCrdtProvider()
      .forgetWindow(windowId)
      .catch((err) => {
        log.error('Failed to release CRDT docs for a closed window', { windowId, error: err })
      })
  })
}

/**
 * Register CRDT IPC handlers once at app bootstrap. Handlers resolve the current
 * provider via getCrdtProvider() on every invocation so they survive provider
 * destroy/reset during sign-out teardown — the renderer's useYjsCollaboration
 * cleanup can legitimately call closeDoc after main-process teardown has run.
 */
export function registerCrdtIpcHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle(CRDT_CHANNELS.OPEN_DOC, async (event, rawInput: unknown) => {
    const { noteId } = CrdtOpenDocSchema.parse(rawInput)
    const win = BrowserWindow.fromWebContents(event.sender)
    const windowId = win?.id
    // Hook before the first await: a window destroyed while open() is in
    // flight would already have emitted 'closed' by the time we got back.
    if (win) hookWindowClose(win)

    const provider = getCrdtProvider()
    if (!provider.isInitialized()) {
      return { success: false, error: 'CRDT provider not initialized' }
    }

    const validation = provider.validateNoteForCrdt(noteId)
    if (!validation.ok) {
      return { success: false, error: validation.error }
    }

    await provider.open(noteId, windowId)
    return { success: true }
  })

  ipcMain.handle(CRDT_CHANNELS.CLOSE_DOC, async (event, rawInput: unknown) => {
    const { noteId } = CrdtCloseDocSchema.parse(rawInput)
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id
    await getCrdtProvider().close(noteId, windowId)
    return { success: true }
  })

  ipcMain.handle(CRDT_CHANNELS.APPLY_UPDATE, async (event, rawInput: unknown) => {
    const { noteId, update } = CrdtApplyUpdateSchema.parse(rawInput)
    const sourceWindowId = BrowserWindow.fromWebContents(event.sender)?.id ?? -1
    getCrdtProvider().applyIpcUpdate(noteId, update, sourceWindowId)
    // Body edits arrive through this channel, not the notes UPDATE IPC —
    // typing never counted as note_updated before this. Remote sync updates
    // take the network path inside the provider and are deliberately excluded.
    trackNoteBodyEditThrottled(noteId)
  })

  ipcMain.handle(
    CRDT_CHANNELS.SYNC_STEP_1,
    createValidatedHandler(
      CrdtSyncStep1Schema,
      async (input): Promise<CrdtSyncStep1Result | null> => {
        const provider = getCrdtProvider()
        if (!provider.isInitialized()) return null
        const doc = await provider.open(input.noteId)
        const diff = Y.encodeStateAsUpdate(doc, input.stateVector)
        const stateVector = Y.encodeStateVector(doc)
        return { diff, stateVector }
      }
    )
  )

  ipcMain.handle(
    CRDT_CHANNELS.SYNC_STEP_2,
    createValidatedHandler(CrdtSyncStep2Schema, async (input) => {
      getCrdtProvider().applyIpcSyncStep2(input.noteId, input.diff)
    })
  )
}
