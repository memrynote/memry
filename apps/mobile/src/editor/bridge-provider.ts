import {
  BRIDGE_B_MAX_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_T_FLUSH_MS,
  bucketForMsgCount,
  emptyBridgeCounters,
  GuestEnvelopeSchema,
  type BridgeCounters,
  type GuestMsg,
  type HostMsg
} from '@memry/contracts/webview-bridge'
import { createLogger } from '../lib/logger'

const log = createLogger('EditorBridge')

/**
 * The RN half of the editor bridge (T059).
 *
 * Mirror of `apps/mobile/editor-web/src/bridge.ts`, compiled against the same
 * contract module. Three responsibilities, all of them launch requirements
 * rather than optimizations (Constitution V):
 *
 *   * BATCHING — `T_flush` / `B_max` from R4, or an explicit flush. A
 *     per-update crossing is a defect even where it measures comfortably.
 *   * GAP DETECTION — a `seq` that skips means an envelope was lost, and the
 *     only correct response is a full `doc-load` resync. Silently continuing
 *     leaves the two replicas diverged with no symptom until a later edit
 *     lands on the wrong state.
 *   * ORIGIN TAGGING — `sid` is the same idea as desktop's `sourceWindowId`;
 *     without it every update we apply comes straight back to us.
 */

export interface BridgeTransport {
  /** Deliver one serialized envelope into the WebView. */
  send(envelope: string): void
}

export type GuestMsgListener = (msg: GuestMsg) => void

export class EditorBridgeProvider {
  readonly sid: string
  private seq = 0
  private lastGuestSeq = 0
  private pending: HostMsg[] = []
  private pendingBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<GuestMsgListener>()
  private counters: BridgeCounters = emptyBridgeCounters()
  private transport: BridgeTransport | null = null
  /** Latest delivery latencies, for the G3 keystroke measurement (T074). */
  private deliverySamples: number[] = []
  private lastDeliveryMs = 0

  /**
   * Called when a gap demands a full resync. Set after construction rather
   * than injected, because the handler has to send a `doc-load` built from
   * state the provider itself does not own — and a provider re-created every
   * time that handler's identity changed would reset its sequence counters
   * mid-session.
   */
  private resyncHandler: (reason: string) => void = () => {}

  constructor(sid: string) {
    this.sid = sid
  }

  onResyncNeeded(handler: (reason: string) => void): () => void {
    this.resyncHandler = handler
    return () => {
      this.resyncHandler = () => {}
    }
  }

  attach(transport: BridgeTransport): void {
    this.transport = transport
    // The guest sends `ready` while its script is still evaluating, which can
    // beat `onLoadEnd`. The `cfg` + `doc-load` answer to it therefore queues
    // against no transport, and without this flush it is never delivered —
    // a blank editor with no error anywhere.
    this.flush()
  }

  /**
   * Detach on unmount. Pending messages are DROPPED deliberately: the WebView
   * is gone, so there is nothing to deliver them to, and every one of them was
   * already applied to the RN-owned doc before it was queued.
   */
  detach(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending = []
    this.pendingBytes = 0
    this.transport = null
  }

  onGuestMsg(listener: GuestMsgListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getCounters(): BridgeCounters {
    return {
      ...this.counters,
      msgsPerEnvelope: [...this.counters.msgsPerEnvelope],
      msgsPerEnvelopeReceived: [...this.counters.msgsPerEnvelopeReceived]
    }
  }

  getDeliverySamples(): number[] {
    return [...this.deliverySamples]
  }

  /**
   * Delivery latency of the envelope currently being dispatched.
   *
   * Read by the latency rig from inside a guest-message listener, which is the
   * only point where "this update" and "the envelope that carried it" are both
   * in hand — re-deriving it afterwards would time a different envelope.
   */
  getLastDeliveryMs(): number {
    return this.lastDeliveryMs
  }

  resetCounters(): void {
    this.counters = emptyBridgeCounters()
    this.deliverySamples = []
    this.lastDeliveryMs = 0
  }

  send(msg: HostMsg): void {
    const bytes =
      msg.type === 'y-update'
        ? msg.updatesB64.reduce((sum, u) => sum + u.length, 0)
        : msg.type === 'doc-load'
          ? msg.stateB64.length
          : JSON.stringify(msg).length
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

  /** Send now. Used for `doc-load`, `exec`, and background transitions. */
  flush(): void {
    // Nothing to deliver it to yet: leave the batch AND its timer alone.
    // Clearing the timer here would strand the queue until the next `send()`
    // happened to re-arm it.
    if (!this.transport) return
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
    this.transport.send(
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
   * Handle one raw `onMessage` payload from the WebView. Never throws: a
   * malformed envelope is a bug report, not a crash, and the editor must stay
   * usable while it is being reported.
   */
  receive(raw: string): void {
    const receivedAt = Date.now()
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      log.warn('WebView sent a non-JSON payload')
      return
    }

    const envelope = GuestEnvelopeSchema.safeParse(parsedJson)
    if (!envelope.success) {
      log.warn('WebView envelope failed contract validation', {
        issue: envelope.error.issues[0]?.message
      })
      return
    }

    const { seq, msgs, sentAt } = envelope.data
    let gapped = false
    if (this.lastGuestSeq > 0 && seq !== this.lastGuestSeq + 1) {
      this.counters.seqGaps += 1
      log.warn('Bridge seq gap; forcing a full resync', { expected: this.lastGuestSeq + 1, seq })
      gapped = true
    }
    this.lastGuestSeq = seq
    this.counters.envelopesReceived += 1
    this.counters.msgsReceived += msgs.length
    this.counters.msgsPerEnvelopeReceived[bucketForMsgCount(msgs.length)] += 1
    if (sentAt !== undefined) {
      this.lastDeliveryMs = receivedAt - sentAt
      this.deliverySamples.push(this.lastDeliveryMs)
      // Bounded: a long editing session would otherwise grow this without
      // limit for a number only the rig ever reads.
      if (this.deliverySamples.length > 2000) this.deliverySamples.shift()
    }

    // The envelope is still DELIVERED after a gap. Its messages are valid —
    // Yjs updates are order-independent and idempotent — and dropping the batch
    // would also drop a `ready`, which is exactly what arrives first after the
    // WebView's content process is reclaimed and re-created.
    for (const msg of msgs) {
      if (msg.type === 'err' && msg.code === 'BRIDGE_SEQ_GAP') {
        this.requestResync(`guest reported ${msg.detail}`)
        continue
      }
      for (const listener of this.listeners) {
        try {
          listener(msg)
        } catch (err) {
          // Same rule as the guest half: one throwing handler must not take
          // the rest of a contiguous envelope with it, because nothing would
          // detect that loss.
          log.error('Bridge message handler threw', {
            type: msg.type,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    if (gapped) this.requestResync(`guest seq gap at ${seq}`)
  }

  /**
   * Ask for a full `doc-load`.
   *
   * The sequence counters are deliberately NOT reset. Restarting `seq` at 0
   * makes every following envelope read as a fresh gap on the guest, whose
   * `lastHostSeq` has not moved — an infinite resync loop that remounts the
   * editor each round.
   */
  private requestResync(reason: string): void {
    this.counters.resyncs += 1
    this.pending = []
    this.pendingBytes = 0
    this.resyncHandler(reason)
  }
}

/**
 * `injectJavaScript` rather than `WebView.postMessage`: the latter is
 * deprecated in react-native-webview and only reaches `document`, while the
 * injected dispatch reaches the listeners the guest actually installs.
 */
export function createInjectionTransport(inject: (js: string) => void): BridgeTransport {
  return {
    send(envelope) {
      // JSON.stringify twice: once for the envelope, once so the envelope
      // survives being embedded in a JS source string.
      inject(
        `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(envelope)} })); true;`
      )
    }
  }
}
