import { Stack } from 'expo-router'
import { EditorHost } from '@/editor/editor-host'

export default function NotesLayout() {
  // `EditorHost` renders ONE editor WebView as a sibling of the stack (#2030).
  // This layout is mounted while the notes list is on screen and stays mounted
  // across every `router.push('/notes/<id>')`, so the guest is warm before the
  // first tap and every note after it switches with a `doc-load` instead of a
  // fresh WKWebView — which was 489 ms of a 567 ms open.
  //
  // Every screen in this stack draws its own nav bar (boards 26, 27, 28/29).
  // Left `true`, the native header renders for the whole push animation and is
  // only torn down once a per-screen `Stack.Screen` override lands a frame
  // later — a second bar visibly stacked over the real one on every open.
  return (
    <EditorHost>
      <Stack screenOptions={{ headerShown: false }} />
    </EditorHost>
  )
}
