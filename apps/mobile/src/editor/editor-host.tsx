import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import {
  Animated,
  Dimensions,
  I18nManager,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent
} from 'react-native'
import type { EditorHostContainer, ScreenTransition } from './editor-host-controller'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useColors } from '@/theme/use-colors'
import { loadEditorWebHtml } from './editor-web-asset'
import { mark } from './__rig__/open-trace'
import { EditorHostController } from './editor-host-controller'

/**
 * The one editor WebView, hoisted above the note routes (#2030).
 *
 * It is rendered by the notes stack's layout, which is mounted while the notes
 * list is on screen and stays mounted across every `router.push('/notes/<id>')`
 * — so the guest is warm before the first tap and survives every open after it.
 * The note route keeps a placeholder where the editor used to be and reports
 * that placeholder's window frame here; this component positions itself onto
 * it. Reporting the frame rather than recomputing it is what keeps the two in
 * agreement when the metadata block above the editor changes height.
 *
 * The frame says where the editor belongs once the route has ARRIVED, and the
 * route arrives by sliding. Being a sibling of the stack, this view is not
 * carried by that slide, so it applies the offset itself from the route's own
 * transition (#2053) — the same animation, read as a position rather than
 * waited on as an event. It used to wait: hidden until something said the push
 * had ended, which cost 475 ms of blank body per open because every signal that
 * could say so needs the JS thread at the moment the open is busiest.
 *
 * It rides a POP only as far as the route survives one, which on device is not
 * far. `router.back()` takes the note screen out of the React tree while
 * `react-native-screens` keeps its native views on screen for the animation, so
 * the attachment is already gone and this host has no mounted note to draw: the
 * body still blanks for the length of a pop. Closing that means holding the
 * departing note here until the pop ends, which is a separate change with a
 * release problem of its own — the doc has to stop being in use at the right
 * moment, or the doc manager's eviction cap quietly stops bounding anything.
 *
 * The keyboard behaviour lives here rather than in the route, so the frame the
 * route reports is a stable rectangle that the keyboard animation never moves.
 */

const EditorHostContext = createContext<EditorHostController | null>(null)

export function useEditorHost(): EditorHostController {
  const controller = useContext(EditorHostContext)
  if (!controller) {
    throw new Error('EditorView must be rendered inside the notes stack, under <EditorHost>')
  }
  return controller
}

export function EditorHost({ children }: { children: ReactNode }) {
  const controller = useMemo(() => new EditorHostController(), [])
  useEffect(() => () => controller.dispose(), [controller])

  return (
    <EditorHostContext.Provider value={controller}>
      <View style={styles.fill}>
        {children}
        {/* After the children, so the editor draws over the note screen's
            placeholder rather than under it. */}
        <HostWebView controller={controller} />
      </View>
    </EditorHostContext.Provider>
  )
}

/**
 * How far off screen a route sits at either end of its transition.
 *
 * `progress` runs 0 → 1 through both a push and a pop, and `closing` is which
 * of the two: arriving, the screen starts a full width out and lands at 0;
 * leaving, it starts at 0 and ends a full width out. Both terms are zero at
 * rest and after a CANCELLED swipe back, which returns `progress` to 0 with
 * `closing` still 1 — so the resting position needs no separate case.
 *
 * Built out of `Animated` arithmetic on the values `react-native-screens`
 * drives through a native `Animated.event`, so the whole chain is a native
 * animated graph and the offset is computed on the UI thread. Deriving it in JS
 * would put this back on exactly the thread whose congestion the reveal gate
 * was losing to.
 */
function slideOffset(transition: ScreenTransition, width: number): Animated.AnimatedNode {
  const { progress, closing } = transition
  const arriving = Animated.multiply(Animated.subtract(1, progress), Animated.subtract(1, closing))
  const leaving = Animated.multiply(progress, closing)
  // Negative in RTL, where UIKit pushes from the other edge.
  return Animated.multiply(I18nManager.isRTL ? -width : width, Animated.add(arriving, leaving))
}

function HostWebView({ controller }: { controller: EditorHostController }) {
  const webViewRef = useRef<WebView>(null)
  // Seeded from the window rather than zero. The guest starts loading the
  // moment it is created, and this is the prewarm: a first frame at height 0
  // is the one case where WebKit could reasonably defer the work this host
  // exists to do early. `onLayout` corrects it a frame later either way.
  // The width is the slide's own scale, and this container spans the window, so
  // both come from the one measurement rather than from `Dimensions` at render.
  const [parked, setParked] = useState(() => {
    const window = Dimensions.get('window')
    return { width: window.width, height: window.height }
  })
  const colors = useColors()
  const html = useMemo(() => loadEditorWebHtml(), [])
  const state = useSyncExternalStore(controller.subscribe, controller.getState)

  // Handed to the controller so a note can measure its editor's place against
  // this exact view, rather than against the window and a second measurement
  // that can go stale independently.
  const onContainerRef = useCallback(
    (node: EditorHostContainer | null) => controller.setContainerView(node),
    [controller]
  )

  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setParked((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height }
    )
  }, [])

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => controller.bridge.receive(event.nativeEvent.data),
    [controller]
  )

  const onLoadEnd = useCallback(() => {
    controller.webViewLoaded((js) => webViewRef.current?.injectJavaScript(js))
  }, [controller])

  const onTerminated = useCallback(() => controller.guestCrashed(), [controller])

  // `react-native-webview` puts `backgroundColor: '#ffffff'` in its own style
  // and derives the WKWebView's `opaque` flag from it, stamping the colour on
  // the web view, its scroll view and the host view. The caller's `style`
  // composes LAST, so handing it the paper here is what makes the opaque layer
  // under the document the app's paper rather than white (#2033).
  const webViewStyle = useMemo(
    () => [styles.fill, { backgroundColor: colors.canvas.background }],
    [colors]
  )

  // Placed as soon as a note reports a frame, VISIBLE on the controller's own
  // terms. The two are separate on purpose: laying the guest out at its final
  // size while it is still transparent is what lets it paint there, so
  // revealing it is an opacity change and never a reflow.
  const geometry = state.frame ?? { top: 0, height: parked.height }

  const { transition } = state
  const slide = useMemo(
    () => (transition ? slideOffset(transition, parked.width) : null),
    [parked.width, transition]
  )

  // Whether the mounted note handed over an animation for the guest to ride.
  // Without one the editor is drawn straight at its resting place, which over a
  // screen still sliding in is the failure the reveal gate used to exist to
  // prevent — so a trace with fewer of these than opens is the finding.
  const boundFor = useRef<string | null>(null)
  useEffect(() => {
    if (!state.mountedDocId || !transition) return
    if (boundFor.current === state.mountedDocId) return
    boundFor.current = state.mountedDocId
    mark(state.mountedDocId, 'transitionBound')
  }, [state.mountedDocId, transition])

  // The moment the body joins the screen the reader is watching. It rides the
  // rest of the push in from there, exactly as the note's title and nav bar do,
  // so this is the same event for the body as a first frame is for the chrome.
  // `painted` is the guest's frame callback and can land while the host is
  // still transparent, so a report that stopped there would claim an open the
  // reader had not seen yet.
  const revealedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!state.visible || !state.mountedDocId) {
      if (!state.visible) revealedFor.current = null
      return
    }
    if (revealedFor.current === state.mountedDocId) return
    revealedFor.current = state.mountedDocId
    mark(state.mountedDocId, 'revealed')
  }, [state.mountedDocId, state.visible])

  return (
    <View
      ref={onContainerRef}
      style={styles.container}
      onLayout={onContainerLayout}
      pointerEvents="box-none"
    >
      <Animated.View
        style={[
          styles.host,
          geometry,
          state.visible ? styles.shown : styles.hidden,
          slide ? { transform: [{ translateX: slide }] } : null
        ]}
        pointerEvents={state.visible ? 'auto' : 'none'}
      >
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <WebView
            key={state.instance}
            ref={webViewRef}
            source={{ html, baseUrl: 'about:blank' }}
            onLoadEnd={onLoadEnd}
            onMessage={onMessage}
            onContentProcessDidTerminate={onTerminated}
            onRenderProcessGone={onTerminated}
            style={webViewStyle}
            javaScriptEnabled
            // The document is local and its CSP forbids every remote fetch;
            // this stops a crafted note from turning a tap into a navigation
            // anyway.
            originWhitelist={['about:blank']}
            allowFileAccess={false}
            allowsInlineMediaPlayback
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView
            automaticallyAdjustContentInsets={false}
            // The editor sizes its own document; a bouncing scroll view under
            // it fights the caret on iOS.
            bounces={false}
            overScrollMode="never"
          />
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // `box-none` so the notes list underneath keeps every touch it would have
  // had; only the editor itself takes them, and only while it is on screen.
  container: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 },
  host: { position: 'absolute', start: 0, end: 0 },
  shown: { opacity: 1 },
  hidden: { opacity: 0 }
})
