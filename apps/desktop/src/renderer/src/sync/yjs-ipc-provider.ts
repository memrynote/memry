import * as Y from 'yjs'
import { Observable } from 'lib0/observable'
import { createLogger } from '@/lib/logger'

const log = createLogger('YjsIpcProvider')

export interface YjsIpcProviderConfig {
  noteId: string
  doc: Y.Doc
}

export class YjsIpcProvider extends Observable<string> {
  readonly noteId: string
  readonly doc: Y.Doc
  private synced = false
  private destroyed = false
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null
  private ipcCleanup: (() => void) | null = null
  private resetCleanup: (() => void) | null = null
  /** Serialises rebinds so two resets in a row cannot interleave handshakes. */
  private rebinding: Promise<void> | null = null

  constructor(config: YjsIpcProviderConfig) {
    super()
    this.noteId = config.noteId
    this.doc = config.doc
  }

  async connect(): Promise<void> {
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'ipc-provider') return
      this.sendUpdate(update)
    }
    this.doc.on('update', this.updateHandler)

    // Note-scoped subscription: the preload registry dispatches by noteId, so
    // this provider is no longer woken by every other open note's updates. The
    // id check stays as a cheap assertion — applying another note's update to
    // this doc would be silent corruption, so it must never be reachable.
    this.ipcCleanup = window.api.onCrdtStateChanged(
      this.noteId,
      (data: { noteId: string; update: Uint8Array; origin: string }) => {
        if (data.noteId !== this.noteId) return
        Y.applyUpdate(this.doc, data.update, 'remote')
        log.debug('Applied remote update', { noteId: this.noteId, bytes: data.update.byteLength })
      }
    )

    // Main can drop the provider that owns this note's doc — sign-out does, and
    // so does any other provider reset — while this editor stays mounted. The
    // binding is dead at that point and nothing else says so: remote updates go
    // on being applied in main and broadcast to a window set this editor is no
    // longer in, so the note silently goes stale until it is closed and
    // reopened. Rebind instead.
    this.resetCleanup = window.api.onCrdtProviderReset(() => {
      this.rebinding = (this.rebinding ?? Promise.resolve())
        .catch(() => {})
        .then(() => this.rebind())
    })

    await this.openDoc()
    if (this.destroyed) return
    await this.performSyncHandshake()
  }

  disconnect(): void {
    if (this.updateHandler) {
      this.doc.off('update', this.updateHandler)
      this.updateHandler = null
    }

    if (this.ipcCleanup) {
      this.ipcCleanup()
      this.ipcCleanup = null
    }

    if (this.resetCleanup) {
      this.resetCleanup()
      this.resetCleanup = null
    }

    window.api.syncCrdt.closeDoc({ noteId: this.noteId }).catch((err: unknown) => {
      log.debug('closeDoc IPC failed (expected during teardown)', {
        noteId: this.noteId,
        error: err
      })
    })
    this.synced = false
    this.emit('status', [{ status: 'disconnected' }])
  }

  get isSynced(): boolean {
    return this.synced
  }

  destroy(): void {
    this.destroyed = true
    this.disconnect()
    super.destroy()
  }

  /**
   * Re-open this note in main and redo the handshake after a provider reset.
   *
   * The local doc is merged rather than replaced: a note stays editable while
   * signed out, so those edits exist only here, and `syncStep1`/`syncStep2`
   * reconciles them with whatever main now holds. Re-opening is also what
   * re-attributes this window to the doc, which is what puts the editor back
   * into main's broadcast set.
   *
   * A failure is logged and dropped rather than thrown: this runs from an IPC
   * event with no caller to receive it, and the provider must stay alive for
   * the next reset.
   */
  private async rebind(): Promise<void> {
    if (this.destroyed) return
    this.synced = false
    try {
      await this.openDoc()
      if (this.destroyed) return
      await this.performSyncHandshake()
      log.debug('Rebound after provider reset', { noteId: this.noteId })
    } catch (err) {
      log.error('Failed to rebind after provider reset', { noteId: this.noteId, error: err })
    }
  }

  private async openDoc(): Promise<void> {
    try {
      const result = await window.api.syncCrdt.openDoc({ noteId: this.noteId })
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to open CRDT doc')
      }
    } catch (err) {
      log.error('Failed to open doc', { noteId: this.noteId, error: err })
      throw err
    }
  }

  private async performSyncHandshake(): Promise<void> {
    if (this.destroyed) return

    const stateVector = Y.encodeStateVector(this.doc)

    const result = await window.api.syncCrdt.syncStep1({
      noteId: this.noteId,
      stateVector
    })

    if (this.destroyed) return

    if (result) {
      Y.applyUpdate(this.doc, result.diff, 'ipc-provider')

      const localDiff = Y.encodeStateAsUpdate(this.doc, result.stateVector)
      if (localDiff.byteLength > 0) {
        await window.api.syncCrdt.syncStep2({
          noteId: this.noteId,
          diff: localDiff
        })
      }
    }

    if (this.destroyed) return

    this.synced = true
    this.emit('synced', [{ synced: true }])
    this.emit('status', [{ status: 'connected' }])
    log.debug('Sync handshake complete', { noteId: this.noteId })
  }

  private sendUpdate(update: Uint8Array): void {
    void window.api.syncCrdt.applyUpdate({
      noteId: this.noteId,
      update
    })
  }
}
