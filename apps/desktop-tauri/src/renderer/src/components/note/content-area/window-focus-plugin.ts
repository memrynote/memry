import { Plugin, PluginKey } from '@tiptap/pm/state'

/**
 * Switching to another window is not leaving the editor (#3967, same class as
 * #3919's `isWindowBlur`). When the app window loses OS focus, the webview
 * blurs the focused contenteditable; TipTap's `focusEvents` plugin turns that
 * into a `blur` meta transaction, and BlockNote's suggestion menu closes on any
 * `focus`/`blur` meta. The `/` menu then vanished mid-query on alt-tab or when
 * another window opened, and Enter split the paragraph instead of running the
 * selected item. The `focus` the window sends back on return closed it too.
 *
 * Registered first (prepended) so these handlers run before TipTap's and
 * ProseMirror's own: a blur while the document has no focus is swallowed, so
 * ProseMirror still counts the editor as focused, and every focus until the
 * next real blur is swallowed too: WebKitGTK sends two on return (Linux VM,
 * #3967). One plugin instance per editor.
 */
export function createWindowFocusPlugin(): Plugin {
  let blurredByWindow = false
  return new Plugin({
    key: new PluginKey('windowFocus'),
    props: {
      handleDOMEvents: {
        blur: (view) => {
          blurredByWindow = !view.dom.ownerDocument.hasFocus()
          return blurredByWindow
        },
        focus: () => blurredByWindow
      }
    }
  })
}
