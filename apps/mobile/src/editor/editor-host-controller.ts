import type { ComponentRef } from 'react'
import type { View } from 'react-native'
import { BRIDGE_PROTOCOL_VERSION, type GuestMsg } from '@memry/contracts/webview-bridge'
import { base64ToBytes } from '../lib/base64'
import { createLogger } from '../lib/logger'
import { createInjectionTransport, EditorBridgeProvider } from './bridge-provider'
import type { OpenDoc } from './doc-manager'
import { EDITOR_WEB_CONTRACT_HASH } from './editor-web-asset'
import { LatencyRecorder } from './__rig__/latency'
import { mark, markGuestPhases, markWebViewLoad } from './__rig__/open-trace'

const log = createLogger('EditorHost')

/**
 * The WebView is created ONCE and switched between notes (#2030).
 *
 * Creating a WKWebView per note open cost 489 ms of a 567 ms open, and every
 * open paid it — WebKit's own warm caches do not help, because the expensive
 * part is the view and its content process, not the bytes. The only way to take
 * it off the interactive path is to stop creating one per open, so this
 * controller owns a single guest for as long as the notes stack is mounted and
 * switches notes by sending `doc-load`.
 *
 * It owns three things, and the third is the one that is easy to get wrong.
 *
 * The guest's lifecycle. Which attached note that guest is showing. And the
 * WRITE PATH from the guest to each open document, keyed by note id. That last
 * one lives here rather than in the note screen because the guest outlives
 * every screen: a `y-update` naming note A can only be A's own edit, since the
 * guest installs that update listener in `mountDoc('A')` and drops it in
 * `teardown()`, and it can arrive after A's screen has gone. A write path that
 * died with the screen would discard those edits, and the guest replica that
 * held them is destroyed at the next `mountDoc` — so nothing anywhere would
 * still have them.
 *
 * The guest state is a value, not a set of booleans, because "loaded" stopped
 * being one question the moment the WebView outlived the note: whether the
 * GUEST is ready is asked once per WebView, and whether THIS note is mounted is
 * asked once per open. Conflating them is how a note ends up behind a permanent
 * spinner, or showing the previous note's body.
 */
export type GuestState = 'cold' | 'loading' | 'ready'

/** Where the mounted note's editor belongs, in the HOST CONTAINER's coordinates. */
export interface EditorFrame {
  top: number
  height: number
}

/** The host's own container view, the frame a note's editor is positioned within. */
export type EditorHostContainer = ComponentRef<typeof View>

/**
 * The mounted note's frame, from two WINDOW measurements taken in one round.
 *
 * One round is the whole point. The vault layout draws a sync banner above this
 * stack whose height changes at runtime and fires `onLayout` on neither view, so
 * a placeholder read after that change and a container origin read from before
 * it disagree by the banner's height and the editor lands that far off.
 *
 * Window coordinates rather than `measureLayout`, which requires its reference
 * to be an ANCESTOR of what it measures. The host is a SIBLING of the stack the
 * note lives in, so the two are cousins, the measurement fails outright, and the
 * editor is never placed at all.
 */
export function editorFrameFrom(
  placeholder: { top: number; height: number },
  containerTop: number
): EditorFrame | null {
  if (placeholder.height <= 0) return null
  return { top: placeholder.top - containerTop, height: placeholder.height }
}

/**
 * One mounted note screen's side of the host.
 *
 * Registered per route instance rather than per note id: a wiki-link cycle can
 * put the same note on the stack twice, and the two screens are different
 * attachments of one document.
 */
export interface HostDoc {
  readonly doc: OpenDoc
  /**
   * Guest messages for the note on screen.
   *
   * `y-update` and `painted` never arrive here. They name a document, and the
   * controller settles them against that document directly, so they are
   * delivered whether or not a screen is still listening.
   */
  onGuestMsg(msg: GuestMsg): void
  /** Push `cfg` + `doc-load`. Called every time this attachment becomes mounted. */
  mount(): void
}

export interface EditorHostState {
  guest: GuestState
  /** The note the host has HANDED to the guest. */
  mountedDocId: string | null
  /**
   * The note the guest has CONFIRMED painting, which is what is on the glass.
   *
   * Different from `mountedDocId` for the width of a switch, and that gap is
   * exactly when showing the WebView would show the previous note's body in
   * this note's frame.
   */
  shownDocId: string | null
  /** The mounted attachment's reported frame, or `null` if it has not reported one. */
  frame: EditorFrame | null
  /** Whether to draw the guest at all. */
  visible: boolean
  /**
   * Whether the host's container view exists to measure against.
   *
   * Published because refs attach children-first: a note's placeholder can be
   * ready to measure a commit before the container it measures against is.
   */
  containerReady: boolean
  /**
   * Bumped to rebuild the WebView after iOS reclaims its content process.
   *
   * `reload()` re-fetches the current URL and the source is an inline HTML
   * string against `about:blank` — there is nothing to re-fetch, so the editor
   * came back blank behind a permanent spinner. A new `key` rebuilds it.
   */
  instance: number
}

export interface DocLayout {
  frame: EditorFrame | null
  /**
   * Whether this route has settled where it belongs on screen.
   *
   * It LATCHES. The host does not slide with the stack, so it must stay hidden
   * through a push and stay VISIBLE through a pop — an outgoing note whose body
   * blanked the instant it lost focus was the whole screen going empty as it
   * animated away.
   */
  onScreen: boolean
}

const NO_LAYOUT: DocLayout = { frame: null, onScreen: false }

/**
 * The write path for one open document.
 *
 * The chain is per note. A single 24 ms envelope can carry several `y-update`
 * messages, and running their persists concurrently races `SELECT MAX(seq)`
 * against the local table's `PRIMARY KEY (doc_id, seq)`, so they are strictly
 * serialized. Merging two notes' chains would put them back in that race.
 */
interface DocSink {
  doc: OpenDoc
  chain: Promise<void>
}

export class EditorHostController {
  /**
   * ONE provider for the WebView's lifetime.
   *
   * Re-keying it per note would reset `seq` while the guest's `lastHostSeq`
   * stayed where it was, and `bridge-provider.ts` documents that exact restart
   * as an infinite resync loop that remounts the editor each round.
   */
  readonly bridge: EditorBridgeProvider

  /**
   * One recorder for the WebView, not one per note.
   *
   * It measures the shared bridge and reads the shared counters off it, so a
   * recorder per note reported the same numbers from several places and reset
   * all of them at once.
   */
  readonly recorder: LatencyRecorder

  private attachments: HostDoc[] = []
  private layouts = new WeakMap<HostDoc, DocLayout>()
  private focused = new WeakMap<HostDoc, boolean>()
  private sinks = new Map<string, DocSink>()
  private inFlight = new Set<Promise<void>>()
  private containerView: EditorHostContainer | null = null
  private webViewStartedAt = Date.now()
  private mountedDoc: HostDoc | null = null
  private shownDocId: string | null = null
  private guest: GuestState = 'cold'
  private instance = 0
  private injectedChars = 0
  private listeners = new Set<() => void>()
  private snapshot: EditorHostState = {
    guest: 'cold',
    mountedDocId: null,
    shownDocId: null,
    frame: null,
    visible: false,
    containerReady: false,
    instance: 0
  }

  constructor(sid = 'rn-editor-host') {
    this.bridge = new EditorBridgeProvider(sid)
    this.recorder = new LatencyRecorder(this.bridge)
    // Both handlers belong to the host rather than to a note: the provider
    // holds a SINGLE resync handler, so two notes registering one would fight
    // over it, and a resync is always for whatever is mounted right now.
    this.bridge.onResyncNeeded((reason) => {
      log.warn('Bridge resync', { docId: this.mountedDoc?.doc.docId ?? null, reason })
      this.syncMount(true)
    })
    this.bridge.onGuestMsg((msg) => this.route(msg))
  }

  getState = (): EditorHostState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Register a mounted note screen.
   *
   * The returned detach unregisters the SCREEN. It does not touch the WebView,
   * which is the cost this host exists to remove, and it does not close the
   * write path — the guest can still be holding this note and still be about to
   * send its last keystrokes.
   */
  attach(doc: HostDoc): () => void {
    const docId = doc.doc.docId
    if (!this.sinks.has(docId)) this.sinks.set(docId, { doc: doc.doc, chain: Promise.resolve() })
    this.attachments.push(doc)
    this.syncMount()
    return () => {
      const at = this.attachments.indexOf(doc)
      if (at < 0) return
      this.attachments.splice(at, 1)
      this.layouts.delete(doc)
      this.focused.delete(doc)
      this.pruneSinks()
      this.syncMount()
    }
  }

  /**
   * Whether this attachment's route is the focused one.
   *
   * This is what picks the note to mount, and attach order cannot: a screen
   * withholds its editor until its own async open resolves, so opening two
   * notes quickly can attach them in the order they finished loading rather
   * than the order they sit in the stack.
   */
  setFocused(doc: HostDoc, focused: boolean): void {
    if (this.focused.get(doc) === focused) return
    this.focused.set(doc, focused)
    this.syncMount()
  }

  /** Where this attachment's route wants the editor drawn, and whether it has settled. */
  setLayout(doc: HostDoc, layout: DocLayout): void {
    this.layouts.set(doc, layout)
    if (doc === this.mountedDoc) this.publish()
  }

  /** The view a note's editor is positioned within. */
  setContainerView(view: EditorHostContainer | null): void {
    if (this.containerView === view) return
    this.containerView = view
    this.publish()
  }

  /**
   * The container's own window origin, read on demand.
   *
   * Called from inside a note's placeholder measurement so both numbers come
   * from the same round; see `editorFrameFrom` for what reading them apart
   * costs.
   *
   * Answers `null` rather than staying silent when there is no container yet,
   * so the caller has one shape to handle and a failure to place the editor
   * cannot be mistaken for nothing having happened. Ordinarily transient, and
   * the `containerReady` flag is what re-runs the measurement.
   */
  measureContainerTop(onMeasured: (top: number | null) => void): void {
    const container = this.containerView
    if (!container) {
      onMeasured(null)
      return
    }
    container.measureInWindow((_x, y) => onMeasured(y))
  }

  /** The transport the guest's `onLoadEnd` hands over. */
  webViewLoaded(inject: (js: string) => void): void {
    if (this.guest === 'cold') this.guest = 'loading'
    // The 489 ms this host removed from the open path did not vanish, it moved
    // here — Notes is the initial tab, so the WebView is built alongside the
    // list's first render. Recorded so the report can say so.
    markWebViewLoad(Date.now() - this.webViewStartedAt)
    // Absent from a warm trace by construction: after a prewarm there is no
    // note to mark it against, which is itself the proof that the WebView was
    // not created for this open.
    if (this.mountedDoc) mark(this.mountedDoc.doc.docId, 'webviewMounted')
    this.bridge.attach(
      createInjectionTransport((js) => {
        this.injectedChars = js.length
        inject(js)
      })
    )
    this.publish()
  }

  /**
   * iOS reclaims WKWebView content processes under memory pressure. The doc is
   * on the RN side, so recovery is a re-created view replaying `doc-load` for
   * whichever note is mounted — no edit is at risk.
   */
  guestCrashed(): void {
    log.warn('WebView content process terminated; re-creating', {
      docId: this.mountedDoc?.doc.docId ?? null
    })
    this.guest = 'cold'
    this.shownDocId = null
    this.instance += 1
    this.webViewStartedAt = Date.now()
    this.bridge.detach()
    this.publish()
  }

  dispose(): void {
    this.bridge.detach()
    this.attachments = []
    this.sinks.clear()
    this.mountedDoc = null
    this.shownDocId = null
    this.guest = 'cold'
    this.publish()
  }

  /**
   * Length of the JS source string of the last envelope injected.
   *
   * The transport owns that string and the open trace needs its size; this is
   * the one place both are in scope (#2044).
   */
  getLastInjectedChars(): number {
    return this.injectedChars
  }

  /**
   * Ask the guest to flush, then wait for the resulting persists.
   *
   * Host-level, like the `exec: flush` it sends: the guest has one outbound
   * queue and this waits on every note's writes, so a screen going into the
   * background can prove the bridge is drained whichever note the guest is
   * holding by then.
   *
   * The wait is bounded rather than open-ended: iOS gives a backgrounding app a
   * few seconds, and an unbounded await here would spend them all if the
   * WebView had already been suspended.
   */
  async flushAndSettle(): Promise<void> {
    // What the guest had sent us BEFORE the flush. An empty in-flight set right
    // after `exec:flush` is the normal state — the reply has not crossed the
    // bridge yet — so breaking on it means waiting for nothing, and the last
    // keystrokes exist only in the WebView's non-durable replica if iOS
    // suspends us a moment later.
    const before = this.bridge.getCounters().msgsReceived

    this.bridge.send({ type: 'exec', cmd: 'flush' })
    this.bridge.flush()

    // Two deadlines, because they answer different questions. The first is
    // "did the guest have anything to send?" — an idle editor never replies,
    // and waiting the full window for that reply would spend the entire
    // backgrounding budget before the outbox drain even starts. The second is
    // "has everything it sent been persisted?".
    const replyDeadline = Date.now() + 250
    const settleDeadline = Date.now() + 2_000
    let sawReply = false

    while (Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (!sawReply && this.bridge.getCounters().msgsReceived > before) sawReply = true

      if (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight])
        continue
      }
      if (sawReply) return
      if (Date.now() >= replyDeadline) return
    }
  }

  private route(msg: GuestMsg): void {
    switch (msg.type) {
      case 'ready':
        this.onGuestReady(msg)
        return

      case 'y-update':
        // Settled against the note it NAMES, mounted or not. The guest only
        // produces an update for the document it has open, so this can only be
        // that note's own edit, and dropping it destroys the edit outright.
        this.persist(msg)
        return

      case 'painted':
        // Guest marks BEFORE the host's own: `mark` stamps `Date.now()`, which
        // is later than every stamp the message carries, and the rig renders
        // one ordered table out of both.
        markGuestPhases(msg.docId, msg.marks)
        mark(msg.docId, 'painted')
        this.shownDocId = msg.docId
        // The guest has torn the previous replica down, so no further update
        // can name it and its write path can go.
        this.pruneSinks()
        this.publish()
        return

      default:
        this.mountedDoc?.onGuestMsg(msg)
    }
  }

  private persist(msg: Extract<GuestMsg, { type: 'y-update' }>): void {
    const sink = this.sinks.get(msg.docId)
    if (!sink) {
      // Only reachable for a note the host never attached, which means nothing
      // opened it — an update for it would have nowhere durable to go.
      log.error('Dropped a guest update for a note with no write path', { docId: msg.docId })
      return
    }

    // Sequential, and awaited: `applyFromGuest` is what makes the update
    // durable, and overlapping calls would race the local sequence.
    const deliveryMs = this.bridge.getLastDeliveryMs()
    const work = sink.chain.then(async () => {
      for (const b64 of msg.updatesB64) {
        try {
          await this.recorder.record(deliveryMs, () => sink.doc.applyFromGuest(base64ToBytes(b64)))
        } catch (err) {
          log.error('Failed to persist an editor update; resyncing', {
            docId: msg.docId,
            error: err instanceof Error ? err.message : String(err)
          })
          // The doc did not move, so the WebView is now AHEAD of the
          // authoritative state. Replaying `doc-load` puts them back in
          // agreement — the failed edit is visibly gone rather than silently
          // present-then-absent on the next open.
          //
          // Only for the note on screen. A replay for one the reader has left
          // would drag the shared guest back to it, and that note's replica is
          // already gone, so there is nothing left to disagree with.
          if (this.mountedDoc?.doc.docId === msg.docId) this.mountedDoc.mount()
        }
      }
    })
    // The chain must never reject, or every later update is skipped.
    sink.chain = work.catch(() => undefined)
    this.inFlight.add(work)
    void work.finally(() => this.inFlight.delete(work))
  }

  /**
   * Drop the write paths nothing can still write to.
   *
   * A sink is kept while a screen holds it, and for the one note the guest has
   * confirmed painting — that note's replica is alive, so its keystrokes are
   * still on their way. Everything else is unreachable: the guest destroyed the
   * replica and detached the listener that produced its updates.
   */
  private pruneSinks(): void {
    const keep = new Set(this.attachments.map((a) => a.doc.docId))
    if (this.shownDocId) keep.add(this.shownDocId)
    for (const docId of [...this.sinks.keys()]) {
      if (!keep.has(docId)) this.sinks.delete(docId)
    }
  }

  private onGuestReady(msg: Extract<GuestMsg, { type: 'ready' }>): void {
    if (this.mountedDoc) mark(this.mountedDoc.doc.docId, 'guestReady')

    if (msg.protocolV !== BRIDGE_PROTOCOL_VERSION) {
      // Only reachable from a stale prebuilt asset; the two halves compile
      // against the same contract module.
      log.error('Bridge protocol mismatch', {
        expected: BRIDGE_PROTOCOL_VERSION,
        got: msg.protocolV
      })
      return
    }
    if (msg.contractHash && msg.contractHash !== EDITOR_WEB_CONTRACT_HASH) {
      log.warn('Editor asset hash differs from the RN-side stamp', {
        guest: msg.contractHash,
        host: EDITOR_WEB_CONTRACT_HASH
      })
    }

    this.guest = 'ready'
    // Forced, because the handshake is the first moment a doc that attached
    // against a cold guest can be handed over — and after a content-process
    // death the note on screen is already the mounted one and still needs its
    // `doc-load` replayed.
    this.syncMount(true)
  }

  /**
   * The attachment whose route is focused.
   *
   * A stack has exactly one focused route, and that is the note the reader is
   * looking at. Attach ORDER is not, because a screen withholds its editor
   * until its own open chain resolves: two quick taps can land back to front,
   * and mounting the wrong one leaves the note in front of the reader spinning
   * with nothing to re-sync it.
   */
  private pickMount(): HostDoc | null {
    for (let i = this.attachments.length - 1; i >= 0; i--) {
      const candidate = this.attachments[i]
      if (this.focused.get(candidate)) return candidate
    }
    // Nothing claims focus, which is the middle of a transition. Hold what the
    // guest already has rather than tearing it down and rebuilding it a frame
    // later.
    if (this.mountedDoc && this.attachments.includes(this.mountedDoc)) return this.mountedDoc
    return this.attachments.at(-1) ?? null
  }

  private syncMount(force = false): void {
    const next = this.pickMount()
    const changed = next !== this.mountedDoc
    if (!force && !changed) {
      this.publish()
      return
    }
    if (changed) this.blurGuest()
    this.mountedDoc = next
    this.publish()
    if (next && this.guest === 'ready') next.mount()
  }

  /**
   * Take the keyboard away from the note the guest is about to stop showing.
   *
   * Unmounting the WebView with the route used to resign first responder for
   * free. It does not unmount any more, and neither `opacity: 0` nor
   * `pointerEvents: 'none'` stops iOS delivering keystrokes to a contenteditable
   * that still holds focus — so a reader who taps back mid-sentence would go on
   * typing into a document nobody can see, every keystroke landing as an edit to
   * a note that has left the screen.
   *
   * Unaddressed on purpose. Blurring is transport-level and has to land on
   * whatever the guest is holding, which is precisely the note being replaced.
   */
  private blurGuest(): void {
    if (this.guest !== 'ready') return
    this.bridge.send({ type: 'exec', cmd: 'blur' })
    this.bridge.flush()
  }

  private publish(): void {
    const layout = (this.mountedDoc ? this.layouts.get(this.mountedDoc) : null) ?? NO_LAYOUT
    const mountedDocId = this.mountedDoc?.doc.docId ?? null
    this.snapshot = {
      guest: this.guest,
      mountedDocId,
      shownDocId: this.shownDocId,
      frame: layout.frame,
      // Three conditions, and each one names a way the guest would otherwise be
      // drawn wrong: with no frame it has nowhere to go, before its route has
      // settled it would be painted over the screen still sliding in front of
      // it, and before the guest confirms the switch it is still showing the
      // note the reader just left.
      visible:
        layout.frame !== null &&
        layout.onScreen &&
        mountedDocId !== null &&
        this.shownDocId === mountedDocId,
      containerReady: this.containerView !== null,
      instance: this.instance
    }
    for (const listener of this.listeners) listener()
  }
}
