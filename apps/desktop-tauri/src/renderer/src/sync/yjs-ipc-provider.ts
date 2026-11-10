import * as Y from 'yjs'
import { Channel } from '@tauri-apps/api/core'
import { Observable } from 'lib0/observable'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { commandErrorCode } from '@/lib/ipc-error'
import { decodeChunk, decodeFramedHeader, invokeBinary, readBinary } from '@/lib/ipc-binary'
import { subscribeToEvent } from '@/services/tauri-event'
import { typingHoldOf } from './typing-hold'
import { commands, events } from '../../../generated/bindings'

const log = createLogger('YjsIpcProvider')

/**
 * Why the window must not edit the note: the host's `readOnly`, the code of a refused edit, or a
 * purge, after which the host takes no edit of this copy.
 */
export type DocReadOnly = 'locked' | 'large-file' | 'excluded' | 'purged'

/** The header of `crdt_open_doc`'s framed answer (`commands/editor.rs`). */
interface OpenedHeader {
  needsSeed: boolean
  stateLength: number
  readOnly?: Exclude<DocReadOnly, 'purged'> | null
}

/** The channel frame of a purged document: the window drops later updates until it reopens. */
const PURGED_FRAME = 4
/**
 * The host asks for this window's typing before it applies an outside edit of the note
 * (`editor/typing.rs`): the byte, then the barrier's id (u32, little endian).
 */
const BARRIER_FRAME = 5
/**
 * The host chose without feeding an outside edit (the typing won): new typing may go. The byte,
 * then the id of the barrier it ends.
 */
const RELEASE_FRAME = 6
/** The origin byte of an update the core took from the note's file (`editor::frame`). */
const EXTERNAL_ORIGIN = 2
/** The host waits this long for the window's answer (`BARRIER_WAIT`). */
const BARRIER_WAIT_MS = 1500
/**
 * A hold no release ends is let go this long after its barrier came: the host's wait for the
 * windows' answers, which another window may use up, then 2 s for the host to take the vault's
 * rows and apply the edit.
 */
const HOLD_MS = BARRIER_WAIT_MS + 2000

/** An empty Yjs update: no structs, no deletions. */
const EMPTY_UPDATE_BYTES = 2

/**
 * The waits before an edit the host failed to store is sent again; the last repeats. The host
 * keeps every later update pending until this one lands, so it is never dropped while the note
 * is open.
 */
const RETRY_DELAYS_MS = [250, 1000, 5000]

/**
 * Failures in a row after which the user is told, a flush fails while the edits stay queued, and
 * a closed note's edit is given up.
 */
const FAILURES_BEFORE_NOTICE = 3

let providerSeq = 0

/**
 * The document holds no body and the host did not seed it from the file. Binding an editor to it
 * would show an empty note, and the first keystroke would write that over the file, so the editor
 * stays on the note's markdown, whose save seeds the document for the next open.
 */
export class DocNeedsSeedError extends Error {
  constructor(noteId: string) {
    super(`The document of ${noteId} holds no body yet`)
    this.name = 'DocNeedsSeedError'
  }
}

/**
 * The close of a note's document in this window, until it lands. The host does not order a close
 * after a reopen from the same window, so an open waits for the close before it.
 */
const pendingCloses = new Map<string, Promise<unknown>>()

export interface YjsIpcProviderConfig {
  noteId: string
  doc: Y.Doc
  /**
   * Whether a stale binding may rebind right now. A doc kept alive for a vault
   * workspace the user left sees every ready event main broadcasts, and the
   * one after a switch belongs to the other vault: rebinding then would open
   * this note in the wrong vault's document. Defaults to always.
   *
   * `readyVaultPath` is the vault named by the latest ready event since the
   * last reset: `undefined` when none arrived.
   */
  canRebind?: (readyVaultPath: string | null | undefined) => boolean
  /**
   * Vault workspace this doc belongs to, sent with every open so the host refuses
   * it when it serves another vault. Null outside a workspace.
   */
  vaultPath?: string | null
}

/**
 * One note's Y.Doc bound to the host's document (`crdt_*` commands): the open answers the state
 * and binds a channel that carries every update another window or writer commits; local updates
 * go back as raw bodies, one in flight at a time.
 */
// oxlint-disable-next-line typescript/no-deprecated -- lib0 Observable is deprecated for ObservableV2; migrating changes the event typing of every consumer
export class YjsIpcProvider extends Observable<string> {
  readonly noteId: string
  readonly doc: Y.Doc
  /** This provider's key in the save registry, which a quit or a template apply flushes. */
  private readonly saveKey: string
  private synced = false
  private destroyed = false
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null
  private resetCleanup: (() => void) | null = null
  private readyCleanup: (() => void) | null = null
  private locksCleanup: (() => void) | null = null
  /** The channel of the latest open; frames of an earlier one, or after the disconnect, are ignored. */
  private channel: Channel<ArrayBuffer> | null = null
  /**
   * The host dropped the document this binding pointed at (a vault close, or a refusal that says
   * the window has not opened it), and no open has served it since. Cleared only by a completed
   * rebind, so a failed one leaves it set for the next ready event.
   */
  private stale = false
  /**
   * The note was deleted under the binding: its updates are dropped until a new mount reopens it.
   * A rebind would merge this copy into the recreated document, so none runs.
   */
  private purged = false
  private readOnlyReason: DocReadOnly | null = null
  /** Local updates not yet sent; sent merged, one request at a time, in order. */
  private outgoing: Uint8Array[] = []
  /** The run sending `outgoing`, while one is. */
  private sending: Promise<void> | null = null
  /** Sends in a row that failed; a stored edit resets it. */
  private sendFailures = 0
  /** Flushes waiting to hear that edits keep failing. */
  private readonly failureWaiters = new Set<() => void>()
  /** The open in flight; the close waits for it, so the host never sees the close first. */
  private opening: Promise<unknown> | null = null
  /** An open was sent, so the teardown closes the note. */
  private opened = false
  /**
   * Barriers being answered whose hold has not begun (a composition runs, or its text settles),
   * and whether the edit each waits for already applied or the host released it: then the hold
   * would begin after its end and refuse typing until its deadline.
   */
  private readonly unheld = new Map<number, boolean>()
  /** Serialises rebinds so two ready events in a row cannot interleave handshakes. */
  private rebinding: Promise<void> | null = null
  private readonly canRebind: (readyVaultPath: string | null | undefined) => boolean
  private readonly vaultPath: string | null
  /** Vault of the editor host main last announced ready; cleared on reset. */
  private readyVaultPath: string | null | undefined = undefined

  constructor(config: YjsIpcProviderConfig) {
    // oxlint-disable-next-line typescript/no-deprecated -- same lib0 Observable base class as above
    super()
    this.noteId = config.noteId
    this.doc = config.doc
    this.canRebind = config.canRebind ?? (() => true)
    this.vaultPath = config.vaultPath ?? null
    providerSeq += 1
    this.saveKey = `crdt-doc:${this.noteId}:${providerSeq}`
  }

  /** Why this window must not edit the note, or null. Emits `read-only` when it changes. */
  get readOnly(): DocReadOnly | null {
    return this.readOnlyReason
  }

  get isSynced(): boolean {
    return this.synced
  }

  /**
   * Re-drive a rebind that `canRebind` held back, e.g. when the workspace that
   * owns this doc is shown again. A no-op unless the binding is stale.
   */
  resumeRebind(): void {
    this.scheduleRebind()
  }

  /**
   * Resolves once every edit made so far reached the host, or was given up on a closed note.
   * Rejects once they keep failing; they stay queued and go when the host recovers.
   */
  async flush(): Promise<void> {
    while (this.sending || this.outgoing.length > 0) {
      if (this.sendFailures >= FAILURES_BEFORE_NOTICE) throw this.notSaved()
      const run = this.sending ?? this.sendQueued()
      let failed!: () => void
      const failing = new Promise<'failing'>((resolve) => (failed = () => resolve('failing')))
      this.failureWaiters.add(failed)
      try {
        if ((await Promise.race([run, failing])) === 'failing') throw this.notSaved()
      } finally {
        this.failureWaiters.delete(failed)
      }
    }
  }

  async connect(): Promise<void> {
    registerPendingSave(this.saveKey, () => this.flush())
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'ipc-provider') return
      this.queueUpdate(update)
    }
    this.doc.on('update', this.updateHandler)

    // The reset fires while the vault closes, with nothing serving: record the death and act on
    // the ready event of the next open.
    this.resetCleanup = subscribeToEvent(events.crdtProviderResetEvent, () => {
      this.readyVaultPath = undefined
      this.markStale()
    })
    this.readyCleanup = subscribeToEvent(events.crdtProviderReadyEvent, (payload) => {
      this.readyVaultPath = payload.vaultPath
      this.scheduleRebind()
    })
    // The host answers a lock only at the open and on a refused edit: once this note's lock is
    // lifted, a fresh open says whether the window may edit it again (a folder lock above it
    // still answers `locked`). The reopen waits for an open in flight, whose answer may predate
    // the change.
    this.locksCleanup = subscribeToEvent(events.vaultLocksChangedEvent, (locks) => {
      if (!locks.notes.includes(this.noteId)) this.scheduleReopen()
    })

    const opened = await this.openDoc()
    if (this.destroyed) return
    if (opened.needsSeed) throw new DocNeedsSeedError(this.noteId)
    await this.finishHandshake(opened.stateVector)
  }

  disconnect(): void {
    if (this.updateHandler) {
      this.doc.off('update', this.updateHandler)
      this.updateHandler = null
    }
    this.resetCleanup?.()
    this.resetCleanup = null
    this.readyCleanup?.()
    this.readyCleanup = null
    this.locksCleanup?.()
    this.locksCleanup = null
    this.channel = null
    typingHoldOf(this.doc).release()

    // The typing still queued goes to the host before the close, which would refuse it, and the
    // close goes after an open in flight, which would otherwise bind the window again.
    const noteId = this.noteId
    const opening = this.opening
    const closing = (async () => {
      await opening?.catch(() => {})
      await this.flush().catch((err: unknown) => {
        log.error('Closing the note with edits the host did not store', { noteId, error: err })
      })
      if (this.opened) await commands.crdtCloseDoc(noteId)
    })()
      .catch((err: unknown) => {
        log.debug('closeDoc failed (expected during teardown)', { noteId, error: err })
      })
      .finally(() => {
        if (pendingCloses.get(noteId) === closing) pendingCloses.delete(noteId)
        unregisterPendingSave(this.saveKey)
      })
    pendingCloses.set(noteId, closing)
    this.synced = false
    this.emit('status', [{ status: 'disconnected' }])
  }

  destroy(): void {
    this.destroyed = true
    this.disconnect()
    // oxlint-disable-next-line typescript/no-deprecated -- same lib0 Observable base class as above
    super.destroy()
  }

  /**
   * The binding is dead. Nothing goes over IPC and the doc stays mounted and editable: edits made
   * now live in this Y.Doc and the rebind's handshake carries them across.
   */
  private markStale(): void {
    if (this.destroyed || this.stale) return
    this.stale = true
    this.synced = false
    this.emit('status', [{ status: 'disconnected' }])
    log.debug('Binding marked stale', { noteId: this.noteId })
  }

  private markPurged(): void {
    if (this.purged) return
    this.purged = true
    this.synced = false
    this.outgoing = []
    this.setReadOnly('purged')
    this.emit('status', [{ status: 'disconnected' }])
    log.info('Document purged under the editor; updates dropped until it reopens', {
      noteId: this.noteId
    })
  }

  private setReadOnly(reason: DocReadOnly | null): void {
    if (this.readOnlyReason === reason) return
    this.readOnlyReason = reason
    this.emit('read-only', [reason])
  }

  /**
   * Rebind if, and only if, this binding is stale. Queued behind any rebind in flight so two
   * ready events cannot interleave two handshakes for one note.
   */
  private scheduleRebind(): void {
    if (this.destroyed || !this.stale || !this.canRebind(this.readyVaultPath)) return
    this.rebinding = (this.rebinding ?? Promise.resolve()).catch(() => {}).then(() => this.rebind())
  }

  /**
   * Reopen the note and merge: the local doc keeps what was typed while unbound, and the step-2
   * diff carries it to the host. A failure is logged and leaves `stale` set, so the next ready
   * event tries again.
   */
  private async rebind(): Promise<void> {
    if (this.destroyed || this.purged || !this.stale || !this.canRebind(this.readyVaultPath)) return
    this.synced = false
    try {
      const opened = await this.openDoc()
      if (this.destroyed) return
      this.stale = false
      await this.finishHandshake(opened.stateVector)
      log.info('Rebound to the editor host', { noteId: this.noteId })
    } catch (err) {
      this.stale = true
      log.error('Failed to rebind to the editor host', { noteId: this.noteId, error: err })
    }
  }

  /** Reopens a note the host refused as locked, queued with the rebinds. */
  private scheduleReopen(): void {
    const opening = this.opening
    this.rebinding = (this.rebinding ?? Promise.resolve())
      .catch(() => {})
      .then(() => opening?.catch(() => {}))
      .then(() => this.reopenLocked())
  }

  /**
   * The open answers whether the lock still holds. When it no longer does, the handshake sends
   * what this doc holds beyond the host's state, as a rebind does. A stale binding is left to
   * its rebind; a failure is logged and the note stays read-only.
   */
  private async reopenLocked(): Promise<void> {
    if (this.destroyed || this.purged || this.stale || this.readOnlyReason !== 'locked') return
    try {
      const opened = await this.openDoc()
      if (this.destroyed) return
      await this.finishHandshake(opened.stateVector)
    } catch (err) {
      log.error('Failed to reopen a note after its lock changed', {
        noteId: this.noteId,
        error: err
      })
    }
  }

  /**
   * Opens the note on a new channel and applies its state. Frames that arrive before the answer
   * apply first; Yjs merges either order and ignores what it already holds.
   */
  private async openDoc(): Promise<{ needsSeed: boolean; stateVector: Uint8Array }> {
    await pendingCloses.get(this.noteId)
    if (this.destroyed) return { needsSeed: false, stateVector: new Uint8Array() }
    const channel: Channel<ArrayBuffer> = new Channel((data) => this.receive(channel, data))
    this.channel = channel
    try {
      this.opened = true
      const opening = readBinary(
        'crdt_open_doc',
        this.vaultPath === null
          ? { noteId: this.noteId, onUpdate: channel }
          : { noteId: this.noteId, vaultPath: this.vaultPath, onUpdate: channel }
      )
      this.opening = opening
      const answer = await opening
      const framed = decodeFramedHeader(answer)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `crdt_open_doc` frames an `OpenedHeader` (commands/editor.rs)
      const header = framed.header as OpenedHeader
      const body = framed.body
      // A purge frame that arrived while the open was in flight keeps the copy read-only.
      this.setReadOnly(this.purged ? 'purged' : (header.readOnly ?? null))
      if (this.destroyed) return { needsSeed: false, stateVector: new Uint8Array() }
      Y.applyUpdate(this.doc, body.subarray(0, header.stateLength), 'ipc-provider')
      return { needsSeed: header.needsSeed, stateVector: body.subarray(header.stateLength) }
    } catch (err) {
      log.error('Failed to open doc', { noteId: this.noteId, error: err })
      throw err
    }
  }

  /** Sends what this doc holds beyond the host's state vector, then reports synced. */
  private async finishHandshake(hostStateVector: Uint8Array): Promise<void> {
    if (this.destroyed) return
    const localDiff = Y.encodeStateAsUpdate(this.doc, hostStateVector)
    if (localDiff.byteLength > EMPTY_UPDATE_BYTES && this.readOnlyReason === null) {
      if ((await this.send('crdt_sync_step_2', localDiff)) === 'failed') {
        this.outgoing.unshift(localDiff)
        void this.sendQueued()
      }
    }
    if (this.destroyed) return
    this.synced = true
    this.emit('synced', [{ synced: true }])
    this.emit('status', [{ status: 'connected' }])
    log.debug('Sync handshake complete', { noteId: this.noteId })
  }

  /** One channel frame: `[origin][update]`, the purge byte alone, or a barrier's frame. */
  private receive(channel: Channel<ArrayBuffer>, data: ArrayBuffer): void {
    if (channel !== this.channel) return
    const frame = decodeChunk(data)
    if (frame.byteLength === 1 && frame[0] === PURGED_FRAME) {
      this.markPurged()
      return
    }
    // A purged binding waits for a new mount. A stale one hears nothing on its channel: the
    // host that served it dropped it, and another vault's host never had it.
    if (this.purged || frame.byteLength < 2) return
    if (frame[0] === BARRIER_FRAME || frame[0] === RELEASE_FRAME) {
      const barrier = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, true)
      if (frame[0] === BARRIER_FRAME) {
        void this.answerBarrier(channel, barrier)
        return
      }
      if (this.unheld.has(barrier)) this.unheld.set(barrier, true)
      typingHoldOf(this.doc).release(barrier)
      return
    }
    // Every origin, another window's, the server's, a file edit or the app's, applies as
    // 'remote', so this provider sends none of them back.
    const apply = (): void => Y.applyUpdate(this.doc, frame.subarray(1), 'remote')
    // The outside edit a hold waits for: typing from now on lands in the blocks it makes, and
    // the editor's own changes in answer to it (a link it makes a chip of) must apply. Its
    // feed tells the editors to keep their selection through it.
    if (frame[0] === EXTERNAL_ORIGIN) {
      for (const barrier of this.unheld.keys()) this.unheld.set(barrier, true)
      typingHoldOf(this.doc).feed(apply)
      return
    }
    apply()
  }

  /**
   * The host applies an outside edit of the note once this window sent its typing: a composition
   * in progress ends first (it is never cut), then new typing is held, the queued typing goes,
   * and the host hears the answer. The hold lasts until the edit's frame applies, or the release
   * frame that follows it: typing made before the frame would land in blocks the edit deleted.
   * An edit or release that came before the hold would begin leaves nothing to hold for. A
   * composition that outlasts the host's wait is left alone, and the host does not wait for it.
   */
  private async answerBarrier(channel: Channel<ArrayBuffer>, barrier: number): Promise<void> {
    const hold = typingHoldOf(this.doc)
    const came = Date.now()
    this.unheld.set(barrier, false)
    const ended = await hold.whenNotComposing(BARRIER_WAIT_MS)
    const landed = this.unheld.get(barrier) === true
    this.unheld.delete(barrier)
    if (!ended || channel !== this.channel) return
    if (!landed) hold.hold(barrier, HOLD_MS - (Date.now() - came))
    await this.flush().catch((err: unknown) => {
      log.error('An outside edit applies over edits the host did not store', {
        noteId: this.noteId,
        error: err
      })
    })
    if (channel !== this.channel) return
    await commands.crdtTypingSent(barrier).catch((err: unknown) => {
      log.debug('The host stopped waiting for this window', { noteId: this.noteId, error: err })
    })
  }

  private queueUpdate(update: Uint8Array): void {
    if (this.purged || this.readOnlyReason !== null) return
    this.outgoing.push(update)
    void this.sendQueued()
  }

  /**
   * Sends queued updates in order, merged into one request per round trip, until none is left.
   * An edit the host failed to store goes again after a wait; the run goes on after the teardown
   * too, until the close.
   */
  private sendQueued(): Promise<void> {
    this.sending ??= (async () => {
      while (this.outgoing.length > 0) {
        // A stale binding is refused anyway; its edits stay in the doc for the rebind's diff.
        if (this.stale) {
          this.outgoing = []
          return
        }
        const batch = this.outgoing
        this.outgoing = []
        const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
        if ((await this.send('crdt_apply_update', update)) === 'done') continue
        const failures = (this.sendFailures += 1)
        this.outgoing.unshift(update)
        if (failures === FAILURES_BEFORE_NOTICE) {
          this.tellEditsUnsaved()
          for (const failed of this.failureWaiters) failed()
        }
        if (this.destroyed && failures >= FAILURES_BEFORE_NOTICE) {
          log.error('Gave up on edits the editor host did not store; the note closed', {
            noteId: this.noteId
          })
          this.outgoing = []
          return
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1])
        )
      }
    })().finally(() => {
      this.sending = null
    })
    return this.sending
  }

  private notSaved(): Error {
    return new Error(`Edits to ${this.noteId} did not reach the editor host`)
  }

  private tellEditsUnsaved(): void {
    const t = getI18n().getFixedT(null, 'errors')
    toast.error(t('crdt.editsNotSavedTitle'), { description: t('crdt.editsNotSavedBody') })
  }

  /**
   * Sends one update. A refusal changes the binding's state and is `done`: the update is not sent
   * again. Any other failure is `failed`, and the caller sends it again.
   */
  private async send(
    command: 'crdt_apply_update' | 'crdt_sync_step_2',
    update: Uint8Array
  ): Promise<'done' | 'failed'> {
    try {
      await invokeBinary(command, update, { noteId: this.noteId })
      this.sendFailures = 0
      return 'done'
    } catch (err) {
      switch (commandErrorCode(err)) {
        case 'note_locked':
          this.outgoing = []
          this.setReadOnly('locked')
          break
        case 'note_large_file':
          this.outgoing = []
          this.setReadOnly('large-file')
          break
        case 'note_excluded':
          this.outgoing = []
          this.setReadOnly('excluded')
          break
        case 'document_purged':
          this.markPurged()
          break
        case 'document_not_open':
        case 'editor_not_serving':
          this.markStale()
          this.scheduleRebind()
          break
        default:
          log.error('An edit did not reach the editor host', {
            noteId: this.noteId,
            command,
            error: err
          })
          return 'failed'
      }
      return 'done'
    }
  }
}
