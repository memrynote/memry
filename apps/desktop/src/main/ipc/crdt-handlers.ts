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
      // The editor is no longer gated on a sync session, so this can be the
      // first open of the launch and it now loses a race it never used to run:
      // openVault kicks initPersistence() off without awaiting it (it pays for
      // a preflight child process) and the renderer can reach a note before it
      // settles. Rejecting here is permanent for that editor — it falls open to
      // a non-collaborative markdown editor for the life of the mount, which is
      // exactly the clobber this gate was split to end.
      //
      // Join the init, never start one. Calling initPersistence() from here
      // would let a vault SWITCH open the store against the outgoing vault:
      // closeVault resets the provider before it closes the databases, so in
      // that window the uuid this resolves is still the old vault's, and the
      // incoming vault's own call would then find persistence already settled
      // and keep it. openVault assigns the in-flight promise in the same
      // synchronous run as initDatabase, so a note the renderer can reach at
      // all is a note whose vault already has an init to join.
      await provider.awaitPendingInit()
    }
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
      async (input, event): Promise<CrdtSyncStep1Result | null> => {
        const provider = getCrdtProvider()
        if (!provider.isInitialized()) return null

        // The handshake can be the call that creates the doc: crdt:open-doc may
        // have been skipped or errored, or a provider reset (vault switch) may
        // have dropped the entry in between. Opening it here without the
        // sender's windowId left the doc with an EMPTY windowIds set while the
        // editor was about to type into it — so it counted as inactive, and the
        // next eviction pass could destroy it mid-edit. applyIpcUpdate() then
        // silently returns on the missing entry, dropping the keystrokes.
        // Attribute it to exactly the window crdt:open-doc would have.
        const win = BrowserWindow.fromWebContents(event.sender)
        // Hook before the first await, mirroring open-doc: a window destroyed
        // while open() is in flight has already emitted 'closed'.
        if (win) hookWindowClose(win)

        const doc = await provider.open(input.noteId, win?.id)
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
