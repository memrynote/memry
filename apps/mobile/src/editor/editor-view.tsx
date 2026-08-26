import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCfg,
  type GuestMsg,
  type WikiCandidate
} from '@memry/contracts/webview-bridge'
import { base64ToBytes, bytesToBase64 } from '../lib/base64'
import { createLogger } from '../lib/logger'
import { EDITOR_WEB_CONTRACT_HASH, loadEditorWebHtml } from './editor-web-asset'
import { createInjectionTransport, EditorBridgeProvider } from './bridge-provider'
import type { OpenDoc } from './doc-manager'
import { LatencyRecorder, type G3Measurement } from './__rig__/latency'

const log = createLogger('EditorView')

/**
 * The WebView host for the note body (T064).
 *
 * Owns the bridge, not the document: the Y.Doc arrives already open from the
 * doc manager, and everything this component does is translate between it and
 * the guest. That split is what makes WebView process death cheap — the view
 * can be destroyed and re-created, and the doc it was showing is untouched.
 */

export interface EditorViewProps {
  doc: OpenDoc
  cfg: BridgeCfg
  /** Wiki-link tap. Targets may be `Title` or `Title#Heading`. */
  onNavigate: (target: string) => void
  /** Autocomplete backing store; returns at most a handful of candidates. */
  onWikiQuery: (query: string) => Promise<WikiCandidate[]>
  /** Resolve an image/attachment ref the WebView cannot read for itself. */
  onAssetRequest: (ref: string) => Promise<{
    url?: string
    b64?: string
    mime?: string
    status: 'ready' | 'pending' | 'missing'
  }>
  /**
   * Markdown to seed the doc with when it has no CRDT state at all.
   *
   * A note created here, or one pulled from a desktop whose create-time
   * `content` never produced a CRDT update, has a body in `note_bodies` and an
   * empty doc — it would open blank and the first keystroke would replace the
   * real body everywhere.
   */
  seedMarkdown?: string
  /** Exposed so the screen can drive undo/redo and flush (T071/T076). */
  onReady?: (controls: EditorControls) => void
}

export interface EditorControls {
  undo(): void
  redo(): void
  focus(): void
  /**
   * Force a bridge flush and resolve once everything it shook loose is
   * DURABLE. Awaiting it is what makes a background transition safe: the
   * outbox drain that follows would otherwise read the queue before the last
   * keystrokes had finished their round trip through the WebView.
   */
  flush(): Promise<void>
  /** Insert an uploaded attachment at the cursor (T073). */
  insertAttachment(ref: string, name: string, mime: string): void
  /** G3 keystroke-latency + batching numbers, dev builds only (T074/T075). */
  measure(): G3Measurement
  resetMeasurement(): void
}

export function EditorView({
  doc,
  cfg,
  onNavigate,
  onWikiQuery,
  onAssetRequest,
  seedMarkdown,
  onReady
}: EditorViewProps) {
  const webViewRef = useRef<WebView>(null)
  const [loaded, setLoaded] = useState(false)
  /**
   * Bumped to remount the WebView after iOS reclaims its content process.
   *
   * `reload()` re-fetches the current URL, and the source here is an inline
   * HTML string served against `about:blank` — there is nothing to re-fetch,
   * so the editor came back blank behind a permanent spinner with the bridge
   * never re-attached. A new `key` rebuilds the view from the same source.
   */
  const [instance, setInstance] = useState(0)
  const html = useMemo(() => loadEditorWebHtml(), [])

  // One provider per mounted view. `sid` carries the doc id so a stray envelope
  // from a previous note is identifiable in a log rather than merely wrong.
  const bridge = useMemo(() => new EditorBridgeProvider(`rn-${doc.docId}`), [doc.docId])

  /**
   * Guest updates are persisted STRICTLY IN ORDER, one at a time.
   *
   * A single 24 ms envelope can carry several `y-update` messages, and running
   * their persists concurrently races `SELECT MAX(seq)` against the local
   * table's `PRIMARY KEY (doc_id, seq)` — and opens overlapping
   * `withTransactionAsync` blocks on one expo-sqlite connection, which throws.
   * The losers were caught and logged, so those keystrokes lived in memory and
   * were never persisted or enqueued: silent loss on exactly the fast typing
   * the batching exists to handle.
   */
  const persistChain = useRef<Promise<void>>(Promise.resolve())

  // Tracks the tail of that chain so a flush can wait for it. The WebView round
  // trip is several async hops; a drain fired immediately after `exec:flush`
  // reads the outbox before the last keystroke has reached it.
  const inFlight = useRef(new Set<Promise<void>>())

  // Always instrumented: the recorder costs two Date.now() calls per update,
  // and a measurement path that only exists in a dev build is a measurement of
  // a different app than the one G3 gates.
  const recorder = useMemo(() => new LatencyRecorder(bridge), [bridge])

  /**
   * Ask the guest to flush, then wait for the resulting persists.
   *
   * The wait is bounded rather than open-ended: iOS gives a backgrounding app a
   * few seconds, and an unbounded await here would spend them all if the
   * WebView had already been suspended.
   */
  const flushAndSettle = useCallback(async (): Promise<void> => {
    // What the guest had sent us BEFORE the flush. An empty in-flight set right
    // after `exec:flush` is the normal state — the reply has not crossed the
    // bridge yet — so breaking on it means waiting for nothing, and the last
    // keystrokes exist only in the WebView's non-durable replica if iOS
    // suspends us a moment later.
    const before = bridge.getCounters().msgsReceived

    bridge.send({ type: 'exec', cmd: 'flush' })
    bridge.flush()

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
      if (!sawReply && bridge.getCounters().msgsReceived > before) sawReply = true

      if (inFlight.current.size > 0) {
        await Promise.allSettled([...inFlight.current])
        continue
      }
      if (sawReply) return
      if (Date.now() >= replyDeadline) return
    }
  }, [bridge])

  const sendDocLoad = useCallback(() => {
    bridge.send({
      type: 'doc-load',
      docId: doc.docId,
      stateB64: bytesToBase64(doc.encodeState()),
      // Only when the doc is genuinely empty, so a seed can never overwrite
      // content that already exists.
      ...(doc.isEmpty() && seedMarkdown ? { seedMarkdown } : {})
    })
    bridge.flush()
  }, [bridge, doc, seedMarkdown])

  // A `seq` gap means an envelope was lost; the only correct response is a
  // full `doc-load`, because a dropped update leaves the two replicas diverged
  // with no symptom until a later edit lands on the wrong state.
  useEffect(
    () =>
      bridge.onResyncNeeded((reason) => {
        log.warn('Bridge resync', { docId: doc.docId, reason })
        sendDocLoad()
      }),
    [bridge, doc.docId, sendDocLoad]
  )

  // Remote updates (sync, or another surface) are forwarded to the guest.
  useEffect(() => {
    return doc.onRemoteUpdate((update) => {
      bridge.send({ type: 'y-update', docId: doc.docId, updatesB64: [bytesToBase64(update)] })
    })
  }, [bridge, doc])

  // Config changes (theme, read-only from the kill switch) are pushed live.
  useEffect(() => {
    if (!loaded) return
    bridge.send({ type: 'cfg', ...cfg })
    bridge.flush()
  }, [bridge, cfg, loaded])

  useEffect(() => {
    return () => bridge.detach()
  }, [bridge])

  const handleGuestMsg = useCallback(
    (msg: GuestMsg) => {
      switch (msg.type) {
        case 'ready': {
          if (msg.protocolV !== BRIDGE_PROTOCOL_VERSION) {
            // Only reachable from a stale prebuilt asset; the two halves
            // compile against the same contract module.
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
          bridge.send({ type: 'cfg', ...cfg })
          sendDocLoad()
          setLoaded(true)
          onReady?.({
            undo: () => {
              bridge.send({ type: 'exec', cmd: 'undo' })
              bridge.flush()
            },
            redo: () => {
              bridge.send({ type: 'exec', cmd: 'redo' })
              bridge.flush()
            },
            focus: () => {
              bridge.send({ type: 'exec', cmd: 'focus' })
              bridge.flush()
            },
            flush: () => flushAndSettle(),
            insertAttachment: (ref, name, mime) => {
              bridge.send({ type: 'insert-attachment', ref, name, mime, width: 0 })
              bridge.flush()
            },
            measure: () => recorder.summary(),
            resetMeasurement: () => recorder.reset()
          })
          break
        }

        case 'y-update': {
          if (msg.docId !== doc.docId) return
          // Sequential, and awaited: `applyFromGuest` is what makes the update
          // durable, and overlapping calls would race the local sequence.
          const deliveryMs = bridge.getLastDeliveryMs()
          const work = persistChain.current.then(async () => {
            for (const b64 of msg.updatesB64) {
              try {
                await recorder.record(deliveryMs, () => doc.applyFromGuest(base64ToBytes(b64)))
              } catch (err) {
                log.error('Failed to persist an editor update; resyncing', {
                  docId: doc.docId,
                  error: err instanceof Error ? err.message : String(err)
                })
                // The doc did not move, so the WebView is now AHEAD of the
                // authoritative state. Replaying `doc-load` puts them back in
                // agreement — the failed edit is visibly gone rather than
                // silently present-then-absent on the next open.
                sendDocLoad()
              }
            }
          })
          // The chain must never reject, or every later update is skipped.
          persistChain.current = work.catch(() => undefined)
          inFlight.current.add(work)
          void work.finally(() => inFlight.current.delete(work))
          break
        }

        case 'nav':
          onNavigate(msg.target)
          break

        case 'wiki-query':
          void onWikiQuery(msg.query).then((items) => {
            bridge.send({ type: 'wiki-candidates', reqId: msg.reqId, items })
            bridge.flush()
          })
          break

        case 'asset-req':
          void onAssetRequest(msg.ref).then((asset) => {
            bridge.send({ type: 'asset', reqId: msg.reqId, ...asset })
            bridge.flush()
          })
          break

        case 'err':
          log.warn('Editor reported an error', { code: msg.code, detail: msg.detail })
          break

        case 'metrics':
          // Height is informational for now: the WebView fills the screen and
          // scrolls itself. Kept wired so the native chrome can use it without
          // a contract change.
          break
      }
    },
    [
      bridge,
      cfg,
      doc,
      flushAndSettle,
      onAssetRequest,
      onNavigate,
      onReady,
      onWikiQuery,
      recorder,
      sendDocLoad
    ]
  )

  useEffect(() => bridge.onGuestMsg(handleGuestMsg), [bridge, handleGuestMsg])

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => bridge.receive(event.nativeEvent.data),
    [bridge]
  )

  const onWebViewLoad = useCallback(() => {
    bridge.attach(
      createInjectionTransport((js) => {
        webViewRef.current?.injectJavaScript(js)
      })
    )
  }, [bridge])

  /**
   * iOS reclaims WKWebView content processes under memory pressure. The doc is
   * on the RN side, so recovery is just a re-created view replaying `doc-load`
   * — no edit is at risk, which is the whole point of RN-side ownership.
   */
  const onContentProcessDidTerminate = useCallback(() => {
    log.warn('WebView content process terminated; re-creating', { docId: doc.docId })
    setLoaded(false)
    bridge.detach()
    setInstance((value) => value + 1)
  }, [bridge, doc.docId])

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <WebView
        key={instance}
        ref={webViewRef}
        source={{ html, baseUrl: 'about:blank' }}
        onLoadEnd={onWebViewLoad}
        onMessage={onMessage}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        onRenderProcessGone={onContentProcessDidTerminate}
        style={styles.fill}
        javaScriptEnabled
        // The document is local and its CSP forbids every remote fetch; this
        // stops a crafted note from turning a tap into a navigation anyway.
        originWhitelist={['about:blank']}
        allowFileAccess={false}
        allowsInlineMediaPlayback
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        // The editor sizes its own document; a bouncing scroll view under it
        // fights the caret on iOS.
        bounces={false}
        overScrollMode="never"
      />
      {loaded ? null : (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator />
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
