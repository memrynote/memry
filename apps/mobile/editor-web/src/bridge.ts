import {
  BRIDGE_B_MAX_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_T_FLUSH_MS,
  bucketForMsgCount,
  emptyBridgeCounters,
  GuestEnvelopeSchema,
  HostEnvelopeSchema,
  type BridgeCounters,
  type GuestMsg,
  type HostMsg
} from '@memry/contracts/webview-bridge'

/**
 * The WebView half of the RN↔WebView bridge (T060).
 *
 * Mirror of `apps/mobile/src/editor/bridge-provider.ts`; both compile against
 * the same contract module, so the only way they can disagree is a stale
 * prebuilt asset — which the `contractHash` in the `ready` handshake catches.
 *
 * Persists NOTHING. The RN side owns the Y.Doc; this half holds a replica for
 * editing only, because iOS evicts WKWebView storage and an evicted replica is
 * silent data loss (decision record §4).
 */

type Listener = (msg: HostMsg) => void

const encoder = new TextEncoder()

export class GuestBridge {
  /** Origin tag. Regenerated per page load, so a reload can never echo. */
  readonly sid = `wv-${Math.random().toString(36).slice(2)}-${globalThis.performance.now().toString(36)}`

  private seq = 0
  private lastHostSeq = 0
  private pending: GuestMsg[] = []
  private pendingBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<Listener>()
  private counters: BridgeCounters = emptyBridgeCounters()
  /** Set once the host answers `doc-load`; messages before it are dropped by design. */
  private loaded = false

  constructor(private readonly post: (payload: string) => void) {}

  onHostMsg(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  markLoaded(): void {
    this.loaded = true
  }

  getCounters(): BridgeCounters {
    return {
      ...this.counters,
      msgsPerEnvelope: [...this.counters.msgsPerEnvelope],
      msgsPerEnvelopeReceived: [...this.counters.msgsPerEnvelopeReceived]
    }
  }

  /** Handshake. Sent immediately, unbatched — nothing may precede it. */
  sendReady(schemaV: string, contractHash: string): void {
    this.enqueue({ type: 'ready', protocolV: BRIDGE_PROTOCOL_VERSION, schemaV, contractHash }, 64)
    this.flush()
  }

  send(msg: GuestMsg): void {
    // Rough pre-base64 size: the only field that can be large is a y-update
    // batch, and its base64 strings are already the wire form.
    const bytes =
      msg.type === 'y-update'
        ? msg.updatesB64.reduce((sum, u) => sum + u.length, 0)
        : encoder.encode(JSON.stringify(msg)).length
    this.enqueue(msg, bytes)
  }

  private enqueue(msg: GuestMsg, bytes: number): void {
    this.pending.push(msg)
    this.pendingBytes += bytes
    if (this.pendingBytes >= BRIDGE_B_MAX_BYTES) {
      this.flush()
      return
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), BRIDGE_T_FLUSH_MS)
    }
  }

  /** Explicit flush point: blur, save, background transition (`exec:flush`). */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    const msgs = this.pending
    this.pending = []
    this.pendingBytes = 0
    this.counters.envelopesSent += 1
    this.counters.msgsSent += msgs.length
    this.counters.msgsPerEnvelope[bucketForMsgCount(msgs.length)] += 1
    this.post(
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        sid: this.sid,
        seq: ++this.seq,
        sentAt: Date.now(),
        msgs
      })
    )
  }

  /**
   * Receive one host envelope. A `seq` gap is never absorbed: it is reported
   * so the host can replay `doc-load`, because a dropped y-update is a
   * divergence the editor cannot detect on its own.
   */
  receive(raw: unknown): void {
    if (typeof raw !== 'string') return
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      this.send({ type: 'err', code: 'BRIDGE_BAD_JSON', detail: 'host envelope was not JSON' })
      this.flush()
      return
    }
    const envelope = HostEnvelopeSchema.safeParse(parsedJson)
    if (!envelope.success) {
      this.send({
        type: 'err',
        code: 'BRIDGE_BAD_ENVELOPE',
        detail: envelope.error.issues[0]?.message ?? 'unparseable host envelope'
      })
      this.flush()
      return
    }

    const { seq, msgs } = envelope.data
    if (this.lastHostSeq > 0 && seq !== this.lastHostSeq + 1) {
      this.counters.seqGaps += 1
      this.send({
        type: 'err',
        code: 'BRIDGE_SEQ_GAP',
        detail: `expected ${this.lastHostSeq + 1}, got ${seq}`
      })
      this.flush()
    }
    this.lastHostSeq = seq
    this.counters.envelopesReceived += 1
    this.counters.msgsReceived += msgs.length
    this.counters.msgsPerEnvelopeReceived[bucketForMsgCount(msgs.length)] += 1

    for (const msg of msgs) {
      // Everything except the doc load itself is dropped until the doc exists;
      // applying a y-update to a doc that has no state is how a replica ends up
      // silently diverged from the owner. `probe` is exempt because its whole
      // job is to be timed BEFORE the doc exists — dropping it here would make
      // it unmeasurable at the one moment it is asked about (#2044).
      if (!this.loaded && msg.type !== 'doc-load' && msg.type !== 'cfg' && msg.type !== 'probe')
        continue
      for (const listener of this.listeners) {
        try {
          listener(msg)
        } catch (err) {
          // One throwing handler must not take the rest of the envelope with
          // it. The seq is contiguous, so nothing would detect the loss and no
          // resync would fire — the messages would simply never have happened.
          this.send({
            type: 'err',
            code: 'HANDLER_THREW',
            detail: `${msg.type}: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      }
    }
  }
}

/**
 * Wire the bridge to WKWebView messaging. Both listeners are required:
 * `document` is where iOS delivers `injectJavaScript`-dispatched events and
 * `window` is where the standard `postMessage` path lands.
 */
export function createGuestBridge(): GuestBridge {
  const rn = (globalThis as { ReactNativeWebView?: { postMessage(value: string): void } })
    .ReactNativeWebView
  const bridge = new GuestBridge((payload) => rn?.postMessage(payload))

  const handle = (event: Event): void => {
    bridge.receive((event as MessageEvent).data)
  }
  window.addEventListener('message', handle)
  document.addEventListener('message', handle)

  return bridge
}

/** Guard: this document must never persist editor state (contract rule 1). */
export function assertNoWebStorage(): void {
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      const value = (globalThis as unknown as Record<string, Storage | undefined>)[store]
      if (value && value.length > 0) value.clear()
    } catch {
      // A WebView with storage disabled outright throws on access — which is
      // the desired end state, so there is nothing to do.
    }
  }
}

export { GuestEnvelopeSchema }
