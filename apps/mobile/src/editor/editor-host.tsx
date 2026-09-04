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
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent
} from 'react-native'
import type { EditorHostContainer } from './editor-host-controller'
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

function HostWebView({ controller }: { controller: EditorHostController }) {
  const webViewRef = useRef<WebView>(null)
  // Seeded from the window rather than zero. The guest starts loading the
  // moment it is created, and this is the prewarm: a first frame at height 0
  // is the one case where WebKit could reasonably defer the work this host
  // exists to do early. `onLayout` corrects it a frame later either way.
  const [parkedHeight, setParkedHeight] = useState(() => Dimensions.get('window').height)
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
    setParkedHeight(event.nativeEvent.layout.height)
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
  const geometry = state.frame ?? { top: 0, height: parkedHeight }

  // The end of the open a READER experiences. `painted` is the guest's frame
  // callback, which can land while the editor is still transparent behind the
  // push animation, so a report that stopped there would claim an open the
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
      <View
        style={[styles.host, geometry, state.visible ? styles.shown : styles.hidden]}
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
      </View>
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
