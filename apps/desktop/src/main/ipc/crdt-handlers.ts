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
import { createValidatedHandler } from './validate'

let handlersRegistered = false

/** Test-only: resets the idempotency guard so handlers can be re-registered. */
export function _resetCrdtIpcHandlersForTests(): void {
  handlersRegistered = false
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
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id

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
    const { noteId, update: updateArr } = CrdtApplyUpdateSchema.parse(rawInput)
    const sourceWindowId = BrowserWindow.fromWebContents(event.sender)?.id ?? -1
    getCrdtProvider().applyIpcUpdate(noteId, updateArr, sourceWindowId)
  })

  ipcMain.handle(
    CRDT_CHANNELS.SYNC_STEP_1,
    createValidatedHandler(
      CrdtSyncStep1Schema,
      async (input): Promise<CrdtSyncStep1Result | null> => {
        const provider = getCrdtProvider()
        if (!provider.isInitialized()) return null
        const doc = await provider.open(input.noteId)
        const remoteVector = new Uint8Array(input.stateVector)
        const diff = Y.encodeStateAsUpdate(doc, remoteVector)
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
