import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { ActivityIndicator, Keyboard, StyleSheet, View } from 'react-native'
import { useIsFocused } from 'expo-router'
import { useTransitionProgress } from 'react-native-screens'
import {
  type BridgeCfg,
  type EditorAttachmentBlockType,
  type GuestMsg,
  type WikiCandidate
} from '@memry/contracts/webview-bridge'
import { bytesToBase64 } from '../lib/base64'
import { createLogger } from '../lib/logger'
import { useEditorHost } from './editor-host'
import { HtmlExportRequests } from './html-export-requests'
import { MarkdownExportRequests } from './markdown-export-requests'
import {
  editorFrameFrom,
  type EditorFrame,
  type HostDoc,
  type ScreenTransition
} from './editor-host-controller'
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
  /** Native file picker requested by the WebView toolbar. */
  onInsertRequest: (request: {
    blockType: EditorAttachmentBlockType
    referenceBlockId: string
  }) => void
  /** Software-keyboard state reported by the guest's visual viewport. */
  onKeyboardVisibilityChange?: (visible: boolean) => void
  /** Whether a block/turn-into/link panel is covering the native footer. */
  onPanelVisibilityChange?: (open: boolean) => void
  /** Where the guest's document is scrolled to, in CSS px, once per frame at most. */
  onScroll?: (y: number) => void
  /**
   * Native chrome to float over the editor — the note's title and metadata.
   *
   * Handed to the HOST rather than rendered here. This component is a
   * descendant of the notes stack, the WebView is the stack's later sibling, so
   * anything rendered from here paints UNDER the editor whatever its `zIndex`
   * says. It is positioned onto this note's own frame on the way through, so
   * the caller writes the header in the editor's coordinates and not the
   * host container's.
   */
  chrome?: ReactNode
  /**
   * Native chrome to float over the BOTTOM of the editor — the note's footer.
   *
   * Handed to the host for the same reason `chrome` is, and pinned to the
   * bottom of the host container rather than to this note's frame: it is the
   * screen's floating bar, and the document runs under it.
   */
  footer?: ReactNode
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
  openFind(): void
  /** Serialize the live mounted document, including edits not materialized to SQLite yet. */
  exportMarkdown(): Promise<string>
  /**
   * The live mounted document as a standalone HTML page, for PDF/HTML export.
   *
   * The guest's own rendered DOM and stylesheet rather than a re-render, so
   * what is exported is what the reader is looking at.
   */
  exportHtml(): Promise<string>
  /**
   * Force a bridge flush and resolve once everything it shook loose is
   * DURABLE. Awaiting it is what makes a background transition safe: the
   * outbox drain that follows would otherwise read the queue before the last
   * keystrokes had finished their round trip through the WebView.
   */
  flush(): Promise<void>
  /** Insert an uploaded attachment at the cursor (T073). */
  insertAttachment(
    ref: string,
    name: string,
    mime: string,
    blockType?: EditorAttachmentBlockType,
    referenceBlockId?: string
  ): void
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
type DocScopedCommand = 'undo' | 'redo' | 'focus' | 'open-find'

/**
 * This route's own push or pop animation, in a shape the host can hold on to.
 *
 * `useTransitionProgress` hands back a fresh object on every render of the
 * screen that provides it, while the `Animated.Value`s inside are refs that
 * never change. Rebuilding the pair from those is what stops the host tearing
 * its animated chain down and building a new one on every render of this
 * component — and it renders plenty, once per step of the open.
 *
 * Read HERE rather than up in the note screen, unlike the settle signal it
 * replaces. That one was an EDGE and had to be watched from the moment the
 * route mounted, or a note slower than its own push missed it; these are
 * VALUES, so subscribing late just reads what the animation has already
 * reached. The slow note finds `progress` at 1 and draws in place, which is the
 * right answer rather than a missed event.
 */
function useScreenTransition(): ScreenTransition {
  const { progress, closing } = useTransitionProgress()
  return useMemo(() => ({ progress, closing }), [closing, progress])
}

export function EditorView({
  doc,
  cfg,
  onNavigate,
  onWikiQuery,
  onAssetRequest,
  onInsertRequest,
  onKeyboardVisibilityChange,
  onPanelVisibilityChange,
  onScroll,
  chrome,
  footer,
  seedMarkdown,
  onReady
}: EditorViewProps) {
  const host = useEditorHost()
  const bridge = host.bridge
  const hostState = useSyncExternalStore(host.subscribe, host.getState)
  const markdownExports = useMemo(() => new MarkdownExportRequests(), [])
  const htmlExports = useMemo(() => new HtmlExportRequests(), [])

  /**
   * The keyboard's own height, measured natively and handed to the guest.
   *
   * Measured here rather than in the guest because the WebView sits inside a
   * KeyboardAvoidingView: by the time the keyboard is up, the frame has already
   * shrunk out from under it, so the guest's `visualViewport` inset is a
   * fraction of the keyboard rather than the whole of it. The block picker
   * replaces the keyboard and has to match its height, so it needs this number.
   *
   * The last non-zero height is kept: the picker opens right after the keyboard
   * is dismissed, so zeroing on hide would size it from nothing.
   */
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = Math.round(event.endCoordinates.height)
      if (height > 0) setKeyboardHeight(height)
    })
    return () => sub.remove()
  }, [])
  const guestCfg = useMemo(() => ({ ...cfg, keyboardHeight }), [cfg, keyboardHeight])

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
    bridge.send({ type: 'cfg', ...guestCfg })
    sendDocLoad()
  }, [bridge, guestCfg, sendDocLoad])

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
    bridge.send({ type: 'cfg', ...guestCfg })
    bridge.flush()
  }, [bridge, guestCfg, mounted])

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

        case 'insert-request':
          if (msg.docId === docId) {
            onInsertRequest({
              blockType: msg.blockType,
              referenceBlockId: msg.referenceBlockId
            })
          }
          break

        case 'keyboard-visibility':
          if (msg.docId === docId) onKeyboardVisibilityChange?.(msg.visible)
          break

        case 'editor-panel-visibility':
          if (msg.docId === docId) onPanelVisibilityChange?.(msg.open)
          break

        case 'markdown-export':
          markdownExports.settle(msg)
          break

        case 'html-export':
          htmlExports.settle(msg)
          break

        // Unaddressed, and it needs no guard: the host only routes an
        // unaddressed message to the MOUNTED note, and the guest has one
        // document, so this can only ever be this note's own scroll.
        case 'scroll':
          onScroll?.(msg.y)
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
    [
      bridge,
      docId,
      onAssetRequest,
      onInsertRequest,
      onKeyboardVisibilityChange,
      onPanelVisibilityChange,
      onScroll,
      onNavigate,
      onWikiQuery,
      markdownExports,
      htmlExports
    ]
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
      openFind: () => exec('open-find'),
      exportMarkdown: () =>
        markdownExports.request(docId, (reqId) => {
          bridge.send({ type: 'export-markdown', reqId, docId })
          bridge.flush()
        }),
      exportHtml: () =>
        htmlExports.request(docId, (reqId) => {
          bridge.send({ type: 'export-html', reqId, docId })
          bridge.flush()
        }),
      flush: () => host.flushAndSettle(),
      insertAttachment: (ref, name, mime, blockType, referenceBlockId) => {
        bridge.send({
          type: 'insert-attachment',
          docId,
          ref,
          name,
          mime,
          width: 0,
          ...(blockType ? { blockType } : {}),
          ...(referenceBlockId ? { referenceBlockId } : {})
        })
        bridge.flush()
      },
      measure: () => host.recorder.summary(),
      resetMeasurement: () => host.recorder.reset()
    }
  }, [bridge, docId, host, htmlExports, markdownExports])

  useEffect(() => {
    return () => {
      markdownExports.cancelAll()
      htmlExports.cancelAll()
    }
  }, [docId, htmlExports, markdownExports])

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
  /** So a measurement that never resolves is reported once, not every layout. */
  const unplaced = useRef(false)

  const transition = useScreenTransition()

  const pushLayout = useCallback(() => {
    host.setLayout(hostDoc, { frame: frame.current, transition })
  }, [host, hostDoc, transition])

  /**
   * Both views measured in WINDOW coordinates, inside one round.
   *
   * The container is read from inside the placeholder's own callback rather
   * than cached, so the subtraction cannot straddle a layout change the vault
   * layout's sync banner makes without firing `onLayout` on either view.
   *
   * Not `measureLayout`, which needs its reference to be an ANCESTOR. The host
   * is a sibling of the stack this note lives in, so the two are cousins and
   * that measurement fails outright, leaving the editor unplaced and invisible.
   */
  const measure = useCallback(() => {
    const node = placeholder.current
    if (!node) return
    node.measureInWindow((_x, top, _width, height) => {
      host.measureContainerTop((containerTop) => {
        const next = containerTop === null ? null : editorFrameFrom({ top, height }, containerTop)
        if (!next) {
          // Ordinarily the container's ref has simply not attached yet, and the
          // `containerReady` re-measure below collects it. Logged ONCE because
          // if it never resolves the note renders its title and metadata over a
          // blank white body, which is a symptom nobody would trace back to a
          // measurement without being told.
          if (!unplaced.current) {
            unplaced.current = true
            log.error('Editor placeholder could not be placed; the body will not appear', {
              docId,
              placeholderTop: top,
              placeholderHeight: height,
              containerTop
            })
          }
          return
        }
        unplaced.current = false
        if (frame.current?.top === next.top && frame.current.height === next.height) return
        frame.current = next
        pushLayout()
      })
    })
  }, [docId, host, pushLayout])

  useEffect(() => {
    pushLayout()
    // Re-measured once the container exists to measure against: refs attach
    // children-first, so the first `onLayout` here can run a commit before the
    // host's container is there to be measured against.
    if (hostState.containerReady) measure()
  }, [hostState.containerReady, measure, pushLayout])

  /**
   * The header, positioned onto this note's editor and handed to the host.
   *
   * The chrome slot spans the whole host container, so the offset the caller
   * cannot know is supplied here — from the frame this component already
   * reports, rather than from a nav-bar constant that a sync banner or the
   * read-only banner would silently invalidate.
   *
   * This wrapper CLIPS, and that is the whole reason the header used to stop
   * short: it is only as tall as the header it holds, a transform does not
   * change that height, so a header translated up by its own height leaves the
   * wrapper entirely. Without the clip it kept painting above `frame.top` —
   * over the nav bar — and the last row of it read as pinned there forever.
   */
  const chromeTop = hostState.frame?.top ?? 0
  useEffect(() => {
    host.setChrome(
      hostDoc,
      chrome || footer ? (
        <>
          {chrome ? (
            <View style={[styles.chrome, { top: chromeTop }]} pointerEvents="box-none">
              {chrome}
            </View>
          ) : null}
          {footer ? (
            <View style={styles.footer} pointerEvents="box-none">
              {footer}
            </View>
          ) : null}
        </>
      ) : null
    )
  }, [chrome, chromeTop, footer, host, hostDoc])

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
  // Only as tall as what it holds: the strip below it is the document, and a
  // full-height wrapper would take the touches meant for it. That height is
  // also the clip, so the header scrolls out of the editor rather than up onto
  // the nav bar.
  chrome: { position: 'absolute', start: 0, end: 0, overflow: 'hidden' },
  // Pinned to the host container, not to the note's frame: the footer floats
  // at the bottom of the screen and the document scrolls under it.
  footer: { position: 'absolute', start: 0, end: 0, bottom: 0 },
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
