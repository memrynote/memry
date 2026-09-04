import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Keyboard, StyleSheet, View } from 'react-native'
import { useIsFocused, useNavigation } from 'expo-router'
import { type BridgeCfg, type GuestMsg, type WikiCandidate } from '@memry/contracts/webview-bridge'
import { bytesToBase64 } from '../lib/base64'
import { createLogger } from '../lib/logger'
import { useEditorHost } from './editor-host'
import type { EditorFrame, HostDoc } from './editor-host-controller'
import type { OpenDoc } from './doc-manager'
import type { G3Measurement } from './__rig__/latency'
import { isProbeEnabled, mark, markDocLoadPayload } from './__rig__/open-trace'

const log = createLogger('EditorView')

/**
 * One note's side of the shared editor WebView (T064, #2030).
 *
 * The guest belongs to `EditorHost`, one instance for the whole notes stack, so
 * this component renders a PLACEHOLDER and reports its window frame — the host
 * positions the WebView onto it. It owns what belongs to the note screen: the
 * `doc-load` for this note, the seed replay, the live config, and the wiki-link
 * and asset answers the guest asks for while this note is the one on screen.
 *
 * It deliberately does NOT own the write path back from the guest. A keystroke
 * can reach the host after this screen is gone, and the controller settles it
 * against the document it names.
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
  /**
   * Whether this route has finished animating into place.
   *
   * A prop rather than a hook here because the answer has to be watched from
   * the moment the ROUTE mounts. This component appears only once the note's
   * open chain has resolved, and a note slower than the push animation would
   * miss the event entirely and wait out the fallback. `useRouteSettled` is the
   * hook the screen calls.
   */
  routeSettled: boolean
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

/**
 * The one navigator event a note screen needs.
 *
 * Declared here rather than pulled from `@react-navigation/native-stack`,
 * which the app does not depend on directly: `useNavigation` is generic
 * exactly so a screen can name the surface it uses.
 */
interface StackTransitions {
  addListener(
    type: 'transitionStart' | 'transitionEnd',
    listener: (event: { data: { closing: boolean } }) => void
  ): () => void
  addListener(type: 'gestureCancel', listener: () => void): () => void
}

/**
 * Whether this route has animated into its place on screen.
 *
 * Call it from the SCREEN, above any early return, so the listener is
 * registered while the note is still loading. The host does not slide with the
 * stack, so it stays hidden until this is true — and a screen that only starts
 * watching once its note has opened would miss the event on every note slower
 * than the animation and eat the fallback instead.
 *
 * It goes false again when the route's CLOSING transition ends, which is the
 * last moment the outgoing note is still worth drawing.
 */
export function useRouteSettled(): boolean {
  const navigation = useNavigation<StackTransitions>()
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    // A CLOSING transition unsettles the route the moment it starts, which is
    // what covers the interactive swipe back: the screen tracks the reader's
    // finger while the host stays pinned to the window, so a body left visible
    // would visibly detach from the note it belongs to. `transitionEnd` alone
    // is far too late, since the drag is the whole event.
    const onStart = navigation.addListener('transitionStart', (event) => {
      if (event.data.closing) setSettled(false)
    })
    const onEnd = navigation.addListener('transitionEnd', (event) => {
      setSettled(!event.data.closing)
    })
    // The reader let go and the screen came back, so this route is on screen
    // again and no `transitionEnd` will say so.
    const onCancel = navigation.addListener('gestureCancel', () => setSettled(true))
    const fallback = setTimeout(() => setSettled(true), REVEAL_FALLBACK_MS)
    return () => {
      onStart()
      onEnd()
      onCancel()
      clearTimeout(fallback)
    }
  }, [navigation])

  return settled
}

export function EditorView({
  doc,
  cfg,
  routeSettled,
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
  /** Whether the shared guest is currently holding THIS note. */
  const mounted = hostState.guest === 'ready' && hostState.mountedDocId === docId
  /**
   * Whether the guest has CONFIRMED painting this note.
   *
   * `mounted` flips the instant the host hands the note over, which is before
   * the guest has processed `doc-load` — so anything keyed on it uncovers the
   * previous note's body sitting in this note's frame.
   */
  const shown = hostState.shownDocId === docId

  /**
   * The seed value this note's `doc-load` has already carried.
   *
   * Without it the late-seed replay fires again on every switch back to this
   * note, rebuilding the guest's editor a second time under the caret.
   */
  const seedSent = useRef<string | undefined>(undefined)

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
    // Only when the doc is genuinely empty, so a seed can never overwrite
    // content that already exists. Read at send time, from THIS note's own doc,
    // so a doc switch can never carry the previous note's seed.
    const seed = doc.isEmpty() && seedMarkdown ? seedMarkdown : undefined
    if (seed) seedSent.current = seed

    bridge.send({ type: 'doc-load', docId, stateB64, ...(seed ? { seedMarkdown: seed } : {}) })
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
  // ONLY while this note is the one it is holding.
  useEffect(() => {
    return doc.onRemoteUpdate((update) => {
      if (host.getState().mountedDocId !== docId) return
      bridge.send({ type: 'y-update', docId, updatesB64: [bytesToBase64(update)] })
    })
  }, [bridge, doc, docId, host])

  // A seed resolved by the background probe arrives AFTER the guest has already
  // been handed its (empty) doc, so it needs a fresh `doc-load` to be applied at
  // all. Guarded on emptiness so a late seed can never land on a document that
  // has since acquired content, and on the seed already sent so a switch back to
  // this note does not replay it.
  useEffect(() => {
    if (!mounted || !seedMarkdown || !doc.isEmpty()) return
    if (seedSent.current === seedMarkdown) return
    sendDocLoad()
  }, [doc, mounted, seedMarkdown, sendDocLoad])

  // Config changes (theme, read-only from the kill switch) are pushed live, by
  // the note the guest is holding only — an off-screen note pushing its own
  // would recolour the one the reader is looking at.
  useEffect(() => {
    if (!mounted) return
    bridge.send({ type: 'cfg', ...cfg })
    bridge.flush()
  }, [bridge, cfg, mounted])

  const handleGuestMsg = useCallback(
    (msg: GuestMsg) => {
      switch (msg.type) {
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

        default:
          // `y-update` and `painted` are settled by the controller against the
          // note they name, and `metrics` is a chrome hint the native side does
          // not use yet.
          break
      }
    },
    [bridge, onAssetRequest, onNavigate, onWikiQuery]
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
      doc,
      onGuestMsg: (msg) => latest.current.handleGuestMsg(msg),
      mount: () => latest.current.mountOnGuest()
    }),
    [doc]
  )

  // BEFORE the attach effect, so the host knows which route is focused by the
  // time it has to choose one.
  const focused = useIsFocused()
  useEffect(() => host.setFocused(hostDoc, focused), [focused, host, hostDoc])

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
      flush: () => host.flushAndSettle(),
      insertAttachment: (ref, name, mime) => {
        bridge.send({ type: 'insert-attachment', docId, ref, name, mime, width: 0 })
        bridge.flush()
      },
      measure: () => host.recorder.summary(),
      resetMeasurement: () => host.recorder.reset()
    }
  }, [bridge, docId, host])

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

  const pushLayout = useCallback(() => {
    host.setLayout(hostDoc, { frame: frame.current, onScreen: routeSettled })
  }, [host, hostDoc, routeSettled])

  /**
   * Measured against the host's own container, not the window.
   *
   * One measurement, no arithmetic. A window frame has to be differenced
   * against the container's origin, and the vault layout's sync banner can
   * change height without firing `onLayout` on either view — so the two halves
   * of that subtraction go stale independently and the editor lands a banner's
   * height off.
   */
  const measure = useCallback(() => {
    const container = host.getContainerView()
    const node = placeholder.current
    if (!container || !node) return
    node.measureLayout(
      container,
      (_left, top, _width, height) => {
        if (height <= 0) return
        if (frame.current?.top === top && frame.current.height === height) return
        frame.current = { top, height }
        pushLayout()
      },
      () => log.warn('Could not measure the editor placeholder', { docId })
    )
  }, [docId, host, pushLayout])

  useEffect(() => {
    pushLayout()
    // Re-measured on settle, and once the container exists to measure against:
    // refs attach children-first, so the first `onLayout` here can run a commit
    // before the host's container is there to be measured against.
    if (routeSettled || hostState.containerReady) measure()
  }, [hostState.containerReady, measure, pushLayout, routeSettled])

  /**
   * Give the keyboard back when this screen goes.
   *
   * The WebView used to be unmounted with the route, which resigned first
   * responder for free. It survives now, so a reader who taps back with the
   * caret in the body would otherwise keep an iOS keyboard over the list.
   */
  useEffect(() => () => Keyboard.dismiss(), [])

  /**
   * The spinner means "this note has no body yet", and it LATCHES OFF.
   *
   * Without that it came back every time the guest was handed to another note,
   * so popping back to a note the reader had already read showed a spinner over
   * a document that was never in doubt.
   */
  const [everShown, setEverShown] = useState(false)
  // Adjusted during render rather than in an effect: this is a latch, so React
  // re-running the component just sets it true again, and an effect would show
  // the spinner for one extra frame on every note.
  if (shown && !everShown) setEverShown(true)

  return (
    <View ref={placeholder} style={styles.fill} onLayout={measure}>
      {everShown ? null : (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator />
        </View>
      )}
    </View>
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
