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
  private readyCleanup: (() => void) | null = null
  /**
   * Main dropped the provider this binding pointed at, and no replacement has
   * served us since. Set by the reset event, cleared only by a handshake that
   * actually completed — so a rebind that fails leaves it set and the next
   * PROVIDER_READY tries again. That is the backstop, and it costs no timer.
   */
  private stale = false
  /** Serialises rebinds so two ready events in a row cannot interleave handshakes. */
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
    // reopened.
    //
    // Two events, because "the binding died" and "a binding is possible again"
    // are not the same moment. The reset fires from inside teardown, with the
    // old provider destroyed and no replacement initialized, so re-opening here
    // returns 'CRDT provider not initialized' — every time, on every device.
    // Record the death; act on the recovery.
    this.resetCleanup = window.api.onCrdtProviderReset(() => this.markStale())
    this.readyCleanup = window.api.onCrdtProviderReady(() => this.scheduleRebind())

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

    if (this.readyCleanup) {
      this.readyCleanup()
      this.readyCleanup = null
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
   * Record that main dropped the provider this binding pointed at.
   *
   * Deliberately does nothing over IPC. It also stops this provider claiming to
   * be synced, so nothing downstream reads a dead binding as a live one — but it
   * does NOT tear the doc down or publish a new state to React. The editor stays
   * mounted and fully editable with no account, offline, and signed out; those
   * edits live only in this window's Y.Doc and are exactly what the handshake
   * carries across on rebind. Unmounting here would throw them away.
   */
  private markStale(): void {
    if (this.destroyed || this.stale) return
    this.stale = true
    this.synced = false
    this.emit('status', [{ status: 'disconnected' }])
    log.debug('Binding marked stale by provider reset', { noteId: this.noteId })
  }

  /**
   * A provider in main is ready to serve. Rebind if — and only if — this binding
   * is stale: a ready event for a provider we are already bound to is not a
   * reason to re-run the handshake.
   *
   * Queued behind any rebind still in flight so two ready events cannot
   * interleave two handshakes for one note. The second one then finds `stale`
   * already cleared and returns, so the chain neither stacks work nor holds a
   * timer.
   */
  private scheduleRebind(): void {
    if (this.destroyed || !this.stale) return
    this.rebinding = (this.rebinding ?? Promise.resolve()).catch(() => {}).then(() => this.rebind())
  }

  /**
   * Re-open this note in main and redo the handshake.
   *
   * The local doc is merged rather than replaced: a note stays editable while
   * signed out, so those edits exist only here, and `syncStep1`/`syncStep2`
   * reconciles them with whatever main now holds. Re-opening is also what
   * re-attributes this window to the doc, which is what puts the editor back
   * into main's broadcast set.
   *
   * A failure is logged and dropped rather than thrown: this runs from an IPC
   * event with no caller to receive it, and the provider must stay alive for
   * the next reset. It also leaves `stale` set, which is the whole retry
   * mechanism — the next provider to come up re-drives it.
   */
  private async rebind(): Promise<void> {
    if (this.destroyed || !this.stale) return
    this.synced = false
    try {
      await this.openDoc()
      if (this.destroyed) return
      await this.performSyncHandshake()
      if (this.destroyed) return
      this.stale = false
      log.info('Rebound after provider reset', { noteId: this.noteId })
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
