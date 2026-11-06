import * as Y from 'yjs'
import { Channel } from '@tauri-apps/api/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { Observable } from 'lib0/observable'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { commandErrorCode } from '@/lib/ipc-error'
import { decodeChunk, decodeFramedHeader, invokeBinary, readBinary } from '@/lib/ipc-binary'
import { subscribeToEvent } from '@/services/tauri-event'
import { commands, events } from '../../../generated/bindings'

const log = createLogger('YjsIpcProvider')

/**
 * Why the window must not edit the note: the host's `readOnly`, the code of a refused edit, or a
 * purge, after which the host takes no edit of this copy.
 */
export type DocReadOnly = 'locked' | 'large-file' | 'purged'

/** The header of `crdt_open_doc`'s framed answer (`commands/editor.rs`). */
interface OpenedHeader {
  needsSeed: boolean
  stateLength: number
  readOnly?: Exclude<DocReadOnly, 'purged'> | null
}

/** The channel frame of a purged document: the window drops later updates until it reopens. */
const PURGED_FRAME = 4
/** The origin byte of an update the core took from the note's file (`editor::frame`). */
const EXTERNAL_ORIGIN = 2

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
  /**
   * The typing put back over an outside edit is not sent yet: its request asks the host to keep
   * the file that edit wrote as a version.
   */
  private overOutsideEdit = false
  /** The blocks the latest put-back inserted, until the host took them or refused them. */
  private putBack: Array<Y.XmlElement | Y.XmlText> = []
  /**
   * The host's state vector after this window's latest stored edit, until the channel brought
   * this doc that far: an outside edit stored before the edit may still be on its way, its frame
   * slower than the answer.
   */
  private awaitedState: Map<number, number> | null = null
  /** Sends in a row that failed; a stored edit resets it. */
  private sendFailures = 0
  /** Flushes waiting to hear that edits keep failing. */
  private readonly failureWaiters = new Set<() => void>()
  /** The open in flight; the close waits for it, so the host never sees the close first. */
  private opening: Promise<unknown> | null = null
  /** An open was sent, so the teardown closes the note. */
  private opened = false
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
    this.channel = null

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
    this.putBack = []
    this.awaitedState = null
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
      this.checkAwaited()
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
    // Typing put back over an outside edit while unbound goes in this diff, and its flag with it.
    const overOutsideEdit = this.overOutsideEdit
    this.overOutsideEdit = false
    if (localDiff.byteLength > EMPTY_UPDATE_BYTES && this.readOnlyReason === null) {
      const sent = await this.send('crdt_sync_step_2', localDiff, overOutsideEdit)
      if (sent !== 'done') {
        this.outgoing.unshift(localDiff)
        if (sent === 'failed') this.overOutsideEdit ||= overOutsideEdit
        else this.takeBackPutBack()
        void this.sendQueued()
      }
    }
    if (this.destroyed) return
    this.synced = true
    this.emit('synced', [{ synced: true }])
    this.emit('status', [{ status: 'connected' }])
    log.debug('Sync handshake complete', { noteId: this.noteId })
  }

  /** One channel frame: `[origin][update]`, or the purge byte alone. */
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
    // Every origin, another window's, the server's, a file edit or the app's, applies as
    // 'remote', so this provider sends none of them back.
    const update = frame.subarray(1)
    const typingOnItsWay =
      this.outgoing.length > 0 || this.sending !== null || this.awaitedState !== null
    if (frame[0] === EXTERNAL_ORIGIN && typingOnItsWay) this.keepTypingOver(update)
    else Y.applyUpdate(this.doc, update, 'remote')
    this.checkAwaited()
  }

  /** The host answered a stored edit with its state vector: wait for what this doc lacks of it. */
  private awaitState(answer: Uint8Array): void {
    if (answer.byteLength === 0) return
    this.awaitedState = Y.decodeStateVector(answer)
    this.checkAwaited()
  }

  private checkAwaited(): void {
    const awaited = this.awaitedState
    if (awaited === null) return
    for (const [client, clock] of awaited) {
      if (Y.getState(this.doc.store, client) < clock) return
    }
    this.awaitedState = null
  }

  /**
   * An outside edit the core took before typing still on its way to it. The feed replaced the
   * body's blocks, so the typing, made in blocks the update deletes, would vanish once it lands.
   * The typing wins, as typing the file does not have yet wins in the core (#4030): the body is
   * put back as this window had it, and the host keeps the outside file as a version.
   */
  private keepTypingOver(update: Uint8Array): void {
    const fragment = this.doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    // A body holds elements and text only; a hook is no node of the editor's schema.
    const typed = fragment
      .toArray()
      .filter((node): node is Y.XmlElement | Y.XmlText => !(node instanceof Y.XmlHook))
      .map((node) => node.clone())
    Y.applyUpdate(this.doc, update, 'remote')
    this.overOutsideEdit = true
    this.putBack = typed
    this.doc.transact(() => {
      fragment.delete(0, fragment.length)
      fragment.insert(0, typed)
    })
  }

  /**
   * The host refused the put-back: another window's put-back or typing answered the outside edit
   * first, and the host kept this window's text as a version. The blocks it inserted go, in an
   * edit sent with the refused one, so the host holds no second copy and this doc matches it.
   */
  private takeBackPutBack(): void {
    const ours = new Set<Y.XmlElement | Y.XmlText>(this.putBack)
    this.putBack = []
    const fragment = this.doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    this.doc.transact(() => {
      const nodes = fragment.toArray()
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        if ((node instanceof Y.XmlElement || node instanceof Y.XmlText) && ours.has(node)) {
          fragment.delete(index, 1)
        }
      }
    })
    log.warn('The host kept typing put back over an outside edit as a version', {
      noteId: this.noteId
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
        const overOutsideEdit = this.overOutsideEdit
        this.overOutsideEdit = false
        const sent = await this.send('crdt_apply_update', update, overOutsideEdit)
        if (sent === 'restored') {
          // Sent again unflagged, merged with the edit that takes the put-back out.
          this.outgoing.unshift(update)
          this.takeBackPutBack()
          continue
        }
        if (sent === 'done') continue
        const failures = (this.sendFailures += 1)
        this.outgoing.unshift(update)
        this.overOutsideEdit ||= overOutsideEdit
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
   * again. A refused put-back is `restored`: the caller takes it back and sends the update again.
   * Any other failure is `failed`, and the caller sends it again.
   */
  private async send(
    command: 'crdt_apply_update' | 'crdt_sync_step_2',
    update: Uint8Array,
    overOutsideEdit = false
  ): Promise<'done' | 'restored' | 'failed'> {
    try {
      const meta = overOutsideEdit
        ? { noteId: this.noteId, overOutsideEdit }
        : { noteId: this.noteId }
      const answer = decodeChunk(await invokeBinary(command, update, meta))
      this.sendFailures = 0
      if (overOutsideEdit) this.putBack = []
      this.awaitState(answer)
      return 'done'
    } catch (err) {
      switch (commandErrorCode(err)) {
        case 'outside_edit_restored':
          return 'restored'
        case 'note_locked':
          this.outgoing = []
          this.setReadOnly('locked')
          break
        case 'note_large_file':
          this.outgoing = []
          this.setReadOnly('large-file')
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
