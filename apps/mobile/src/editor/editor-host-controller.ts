import { BRIDGE_PROTOCOL_VERSION, type GuestMsg } from '@memry/contracts/webview-bridge'
import { createLogger } from '../lib/logger'
import { createInjectionTransport, EditorBridgeProvider } from './bridge-provider'
import { EDITOR_WEB_CONTRACT_HASH } from './editor-web-asset'
import { mark } from './__rig__/open-trace'

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
 * It owns exactly two things: the guest's lifecycle, and which attached
 * document that guest is currently showing. Everything per-note — the persist
 * chain, the latency recorder, the doc subscriptions, the seed replay — stays
 * in the `EditorView` that opened the note, which is unmounted with its route
 * and therefore still releases its `OpenDoc` for eviction.
 *
 * The guest state is a value, not a set of booleans, because "loaded" stopped
 * being one question the moment the WebView outlived the note: whether the
 * GUEST is ready is asked once per WebView, and whether THIS note is mounted is
 * asked once per open. Conflating them is how a note ends up behind a permanent
 * spinner, or showing the previous note's body.
 */
export type GuestState = 'cold' | 'loading' | 'ready'

/** Where the mounted note's editor belongs, in WINDOW coordinates. */
export interface EditorFrame {
  top: number
  height: number
}

/**
 * One mounted `EditorView`'s side of the host.
 *
 * Registered per route instance rather than per note id: a wiki-link cycle can
 * put the same note on the stack twice, and the two screens are different
 * attachments of one document.
 */
export interface HostDoc {
  readonly docId: string
  /** Guest messages, delivered only while this attachment is the mounted one. */
  onGuestMsg(msg: GuestMsg): void
  /** Push `cfg` + `doc-load`. Called every time this attachment becomes mounted. */
  mount(): void
}

export interface EditorHostState {
  guest: GuestState
  mountedDocId: string | null
  /** The mounted attachment's reported frame, or `null` if it has not reported one. */
  frame: EditorFrame | null
  /** Whether the mounted attachment's route is settled on screen. */
  visible: boolean
  /**
   * Bumped to rebuild the WebView after iOS reclaims its content process.
   *
   * `reload()` re-fetches the current URL and the source is an inline HTML
   * string against `about:blank` — there is nothing to re-fetch, so the editor
   * came back blank behind a permanent spinner. A new `key` rebuilds it.
   */
  instance: number
}

interface DocLayout {
  frame: EditorFrame | null
  visible: boolean
}

const NO_LAYOUT: DocLayout = { frame: null, visible: false }

export class EditorHostController {
  /**
   * ONE provider for the WebView's lifetime.
   *
   * Re-keying it per note would reset `seq` while the guest's `lastHostSeq`
   * stayed where it was, and `bridge-provider.ts` documents that exact restart
   * as an infinite resync loop that remounts the editor each round.
   */
  readonly bridge: EditorBridgeProvider

  private attachments: HostDoc[] = []
  private layouts = new WeakMap<HostDoc, DocLayout>()
  private mountedDoc: HostDoc | null = null
  private guest: GuestState = 'cold'
  private instance = 0
  private injectedChars = 0
  private listeners = new Set<() => void>()
  private snapshot: EditorHostState = {
    guest: 'cold',
    mountedDocId: null,
    frame: null,
    visible: false,
    instance: 0
  }

  constructor(sid = 'rn-editor-host') {
    this.bridge = new EditorBridgeProvider(sid)
    // Both handlers belong to the host rather than to a note: the provider
    // holds a SINGLE resync handler, so two notes registering one would fight
    // over it, and a resync is always for whatever is mounted right now.
    this.bridge.onResyncNeeded((reason) => {
      log.warn('Bridge resync', { docId: this.mountedDoc?.docId ?? null, reason })
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
   * Register a mounted `EditorView` and make it the note on screen.
   *
   * The returned detach unregisters it and NOTHING else. Tearing the WebView
   * down here is the cost this host exists to remove, and the route's own
   * unmount still releases the `OpenDoc` — which is what keeps the doc
   * manager's cap enforceable.
   */
  attach(doc: HostDoc): () => void {
    this.attachments.push(doc)
    this.syncMount()
    return () => {
      const at = this.attachments.indexOf(doc)
      if (at < 0) return
      this.attachments.splice(at, 1)
      this.layouts.delete(doc)
      this.syncMount()
    }
  }

  /** Where this attachment's route wants the editor drawn, and whether to draw it. */
  setLayout(doc: HostDoc, layout: DocLayout): void {
    this.layouts.set(doc, layout)
    if (doc === this.mountedDoc) this.publish()
  }

  /** The transport the guest's `onLoadEnd` hands over. */
  webViewLoaded(inject: (js: string) => void): void {
    if (this.guest === 'cold') this.guest = 'loading'
    if (this.mountedDoc) mark(this.mountedDoc.docId, 'webviewMounted')
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
      docId: this.mountedDoc?.docId ?? null
    })
    this.guest = 'cold'
    this.instance += 1
    this.bridge.detach()
    this.publish()
  }

  dispose(): void {
    this.bridge.detach()
    this.attachments = []
    this.mountedDoc = null
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

  private route(msg: GuestMsg): void {
    if (msg.type === 'ready') {
      this.onGuestReady(msg)
      return
    }

    // An addressed message goes to the note it names and to nothing else. A
    // `y-update` delivered to the wrong attachment would be persisted into the
    // wrong note's history, which no later edit could undo.
    if (msg.type === 'y-update' || msg.type === 'painted') {
      if (!this.mountedDoc || this.mountedDoc.docId !== msg.docId) return
      this.mountedDoc.onGuestMsg(msg)
      return
    }

    this.mountedDoc?.onGuestMsg(msg)
  }

  private onGuestReady(msg: Extract<GuestMsg, { type: 'ready' }>): void {
    if (this.mountedDoc) mark(this.mountedDoc.docId, 'guestReady')

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
   * Make the topmost attachment the mounted one.
   *
   * Topmost rather than newest-by-id: `router.back()` from note B has to put
   * note A back on the guest, and A's route never re-rendered.
   */
  private syncMount(force = false): void {
    const top = this.attachments.at(-1) ?? null
    if (!force && top === this.mountedDoc) {
      this.publish()
      return
    }
    this.mountedDoc = top
    this.publish()
    if (top && this.guest === 'ready') top.mount()
  }

  private publish(): void {
    const layout = (this.mountedDoc ? this.layouts.get(this.mountedDoc) : null) ?? NO_LAYOUT
    this.snapshot = {
      guest: this.guest,
      mountedDocId: this.mountedDoc?.docId ?? null,
      frame: layout.frame,
      visible: layout.visible,
      instance: this.instance
    }
    for (const listener of this.listeners) listener()
  }
}
