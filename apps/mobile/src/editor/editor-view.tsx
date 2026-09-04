import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useIsFocused, useNavigation } from 'expo-router'
import { type BridgeCfg, type GuestMsg, type WikiCandidate } from '@memry/contracts/webview-bridge'
import { base64ToBytes, bytesToBase64 } from '../lib/base64'
import { createLogger } from '../lib/logger'
import { useEditorHost } from './editor-host'
import type { EditorFrame, HostDoc } from './editor-host-controller'
import type { OpenDoc } from './doc-manager'
import { LatencyRecorder, type G3Measurement } from './__rig__/latency'
import { isProbeEnabled, mark, markDocLoadPayload, markGuestPhases } from './__rig__/open-trace'

const log = createLogger('EditorView')

/**
 * One note's side of the shared editor WebView (T064, #2030).
 *
 * Owns the document, not the view: the Y.Doc arrives already open from the doc
 * manager, and everything here translates between it and the guest. The guest
 * itself belongs to `EditorHost`, one instance for the whole notes stack, so
 * this component renders a PLACEHOLDER and reports its window frame — the host
 * positions the WebView onto it.
 *
 * That split is what makes both WebView process death and note switching
 * cheap. The view can be destroyed, re-created, or handed to another note, and
 * the document it was showing is untouched.
 */

/**
 * How long to wait for the push animation when the navigator reports no
 * `transitionEnd`.
 *
 * The stack's initial route and a push with animation off never emit one, and
 * an editor that waits for it forever is an invisible editor. Longer than the
 * iOS push, so the normal path is always the event and never this.
 */
const REVEAL_FALLBACK_MS = 500

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

/**
 * Only the commands that act on a document are addressed.
 *
 * `flush` and `blur` are transport-level: a note that is still mounted but off
 * screen has to be able to flush the bridge on a background transition, and
 * addressing that would silently drop it.
 */
type DocScopedCommand = 'undo' | 'redo' | 'focus'

export function EditorView({
  doc,
  cfg,
  onNavigate,
  onWikiQuery,
  onAssetRequest,
  seedMarkdown,
  onReady
}: EditorViewProps) {
  const host = useEditorHost()
  const bridge = host.bridge
  const hostState = useSyncExternalStore(host.subscribe, host.getState)

  const docId = doc.docId
  /** Whether the shared guest is currently showing THIS note. */
  const mounted = hostState.guest === 'ready' && hostState.mountedDocId === docId

  /**
   * Guest updates are persisted STRICTLY IN ORDER, one at a time, and per note.
   *
   * A single 24 ms envelope can carry several `y-update` messages, and running
   * their persists concurrently races `SELECT MAX(seq)` against the local
   * table's `PRIMARY KEY (doc_id, seq)` — and opens overlapping
   * `withTransactionAsync` blocks on one expo-sqlite connection, which throws.
   * The losers were caught and logged, so those keystrokes lived in memory and
   * were never persisted or enqueued: silent loss on exactly the fast typing
   * the batching exists to handle.
   *
   * It stays here rather than moving up with the WebView because it is the
   * note's chain, not the view's: merging two notes' persists would put them
   * back in the race the chain removes.
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
    const probing = isProbeEnabled()
    // Queued AHEAD of `doc-load` on purpose. A probe behind it would be timed
    // from the back of the same queue and would be slow whatever the answer is,
    // which discriminates nothing (#2044).
    if (probing) {
      bridge.send({ type: 'probe', slot: 'early' })
      bridge.flush()
      mark(docId, 'probeEarlySent')
    }

    const state = doc.encodeState()
    const stateB64 = bytesToBase64(state)
    bridge.send({
      type: 'doc-load',
      docId,
      stateB64,
      // Only when the doc is genuinely empty, so a seed can never overwrite
      // content that already exists. Read at send time, from THIS note's own
      // doc, so a doc switch can never carry the previous note's seed.
      ...(doc.isEmpty() && seedMarkdown ? { seedMarkdown } : {})
    })
    bridge.flush()
    // After the flush, so the mark covers the state encode AND the injection
    // rather than only the enqueue. Taken on every `doc-load`, including the
    // resync and late-seed replays, because the guest's `docLoadRecv` is
    // likewise the last one it received — marking only the first would pair a
    // replayed receipt against the original send and invent a delay.
    mark(docId, 'docLoadSent')
    // Read straight after the flush, while the injection the transport just
    // made is still the last one.
    markDocLoadPayload(docId, {
      stateBytes: state.byteLength,
      wireChars: stateB64.length,
      injectedChars: host.getLastInjectedChars()
    })

    if (probing) {
      bridge.send({ type: 'probe', slot: 'late' })
      bridge.flush()
      mark(docId, 'probeLateSent')
    }
  }, [bridge, doc, docId, host, seedMarkdown])

  /** Hand this note to the guest. Called by the host every time it becomes the mounted one. */
  const mountOnGuest = useCallback(() => {
    bridge.send({ type: 'cfg', ...cfg })
    sendDocLoad()
  }, [bridge, cfg, sendDocLoad])

  // Remote updates (sync, or another surface) are forwarded to the guest, and
  // ONLY while this note is the one it is showing.
  useEffect(() => {
    return doc.onRemoteUpdate((update) => {
      if (host.getState().mountedDocId !== docId) return
      bridge.send({ type: 'y-update', docId, updatesB64: [bytesToBase64(update)] })
    })
  }, [bridge, doc, docId, host])

  // A seed resolved by the background probe arrives AFTER the guest has
  // already been handed its (empty) doc, so it needs a fresh `doc-load` to be
  // applied at all. Guarded on emptiness, so a late seed can never land on a
  // document that has since acquired content.
  useEffect(() => {
    if (!mounted || !seedMarkdown || !doc.isEmpty()) return
    sendDocLoad()
  }, [doc, mounted, seedMarkdown, sendDocLoad])

  // Config changes (theme, read-only from the kill switch) are pushed live, by
  // the note on screen only — an off-screen note pushing its own would recolour
  // the one the reader is looking at.
  useEffect(() => {
    if (!mounted) return
    bridge.send({ type: 'cfg', ...cfg })
    bridge.flush()
  }, [bridge, cfg, mounted])

  const handleGuestMsg = useCallback(
    (msg: GuestMsg) => {
      switch (msg.type) {
        case 'y-update': {
          if (msg.docId !== docId) return
          // Sequential, and awaited: `applyFromGuest` is what makes the update
          // durable, and overlapping calls would race the local sequence.
          const deliveryMs = bridge.getLastDeliveryMs()
          const work = persistChain.current.then(async () => {
            for (const b64 of msg.updatesB64) {
              try {
                await recorder.record(deliveryMs, () => doc.applyFromGuest(base64ToBytes(b64)))
              } catch (err) {
                log.error('Failed to persist an editor update; resyncing', {
                  docId,
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

        case 'painted':
          // Guest marks BEFORE the host's own: `mark` stamps `Date.now()`,
          // which is later than every stamp the message carries, and the rig
          // renders one ordered table out of both.
          markGuestPhases(msg.docId, msg.marks)
          mark(msg.docId, 'painted')
          break

        case 'nav':
          onNavigate(msg.target)
          break

        // Both of these ALWAYS answer, including on rejection. The guest waits
        // on a reqId; a dropped answer leaves the menu permanently empty, or
        // an image waiting out its 20 s timeout for nothing.
        case 'wiki-query':
          void onWikiQuery(msg.query)
            .catch((err: unknown) => {
              log.warn('Wiki query failed', {
                error: err instanceof Error ? err.message : String(err)
              })
              return []
            })
            .then((items) => {
              bridge.send({ type: 'wiki-candidates', reqId: msg.reqId, items })
              bridge.flush()
            })
          break

        case 'asset-req':
          void onAssetRequest(msg.ref)
            .catch((err: unknown) => {
              log.warn('Asset resolution failed', {
                ref: msg.ref,
                error: err instanceof Error ? err.message : String(err)
              })
              // `pending`, not `missing`: a failure here says nothing about
              // whether the file exists, and `missing` is permanent.
              return { status: 'pending' as const }
            })
            .then((asset) => {
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
    [bridge, doc, docId, onAssetRequest, onNavigate, onWikiQuery, recorder, sendDocLoad]
  )

  /**
   * The callbacks the host reaches this note through.
   *
   * Read through a ref so the registration itself is stable: re-attaching on
   * every render would re-send `doc-load` and rebuild the guest's editor under
   * the caret.
   */
  const latest = useRef({ handleGuestMsg, mountOnGuest })
  useEffect(() => {
    latest.current = { handleGuestMsg, mountOnGuest }
  }, [handleGuestMsg, mountOnGuest])

  const hostDoc = useMemo<HostDoc>(
    () => ({
      docId,
      onGuestMsg: (msg) => latest.current.handleGuestMsg(msg),
      mount: () => latest.current.mountOnGuest()
    }),
    [docId]
  )

  useEffect(() => host.attach(hostDoc), [host, hostDoc])

  const controls = useMemo<EditorControls>(() => {
    const exec = (cmd: DocScopedCommand): void => {
      bridge.send({ type: 'exec', cmd, docId })
      bridge.flush()
    }
    return {
      undo: () => exec('undo'),
      redo: () => exec('redo'),
      focus: () => exec('focus'),
      flush: () => flushAndSettle(),
      insertAttachment: (ref, name, mime) => {
        bridge.send({ type: 'insert-attachment', docId, ref, name, mime, width: 0 })
        bridge.flush()
      },
      measure: () => recorder.summary(),
      resetMeasurement: () => recorder.reset()
    }
  }, [bridge, docId, flushAndSettle, recorder])

  // Per OPEN, not per WebView. The guest's `ready` now fires once for the whole
  // notes stack, so a screen that waited for it would hold `null` controls for
  // every note after the first — taking the save indicator and the background
  // flush with them.
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  useEffect(() => {
    onReadyRef.current?.(controls)
  }, [controls])

  // ---------------------------------------------------------------------
  // Geometry. The host draws the guest onto this placeholder's window frame.
  // ---------------------------------------------------------------------

  const placeholder = useRef<View>(null)
  const frame = useRef<EditorFrame | null>(null)
  const onScreen = useRef(false)

  const pushLayout = useCallback(() => {
    host.setLayout(hostDoc, { frame: frame.current, visible: onScreen.current })
  }, [host, hostDoc])

  const measure = useCallback(() => {
    placeholder.current?.measureInWindow((_x, y, _width, height) => {
      if (height <= 0) return
      if (frame.current?.top === y && frame.current.height === height) return
      frame.current = { top: y, height }
      pushLayout()
    })
  }, [pushLayout])

  /**
   * Revealed only once this route has settled where it belongs.
   *
   * The host is a sibling of the stack and does not slide with it, so an
   * editor shown during a push would be drawn over the list the pushed screen
   * is still sliding in front of. A pop needs no such wait — the screen
   * underneath is already in place — which is why this latches rather than
   * resetting on every blur.
   */
  const focused = useIsFocused()
  const navigation = useNavigation<StackTransitions>()
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    const remove = navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) setOpened(true)
    })
    const fallback = setTimeout(() => setOpened(true), REVEAL_FALLBACK_MS)
    return () => {
      remove()
      clearTimeout(fallback)
    }
  }, [navigation])

  const visible = focused && opened
  useEffect(() => {
    onScreen.current = visible
    pushLayout()
    // Re-measured on reveal: the push animation can move this view under
    // `measureInWindow`, so the frame taken during it is not where it lands.
    if (visible) measure()
  }, [measure, pushLayout, visible])

  return (
    <View ref={placeholder} style={styles.fill} onLayout={measure}>
      {mounted ? null : (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator />
        </View>
      )}
    </View>
  )
}

/**
 * The one navigator event this screen needs.
 *
 * Declared here rather than pulled from `@react-navigation/native-stack`,
 * which the app does not depend on directly: `useNavigation` is generic
 * exactly so a screen can name the surface it uses.
 */
interface StackTransitions {
  addListener(
    type: 'transitionEnd',
    listener: (event: { data: { closing: boolean } }) => void
  ): () => void
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
