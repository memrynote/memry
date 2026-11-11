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
 * ProseMirror's own. A blur while the document has no focus is swallowed, so
 * ProseMirror still counts the editor as focused. Every focus while the editor
 * already counts as focused is swallowed too: WebKitGTK sends two when the
 * window comes back (Linux VM, #3967), and a window coming to the front over an
 * editor that took focus while it was in the background sends one with no
 * window blur before it (CI, #3967). One plugin instance per editor.
 */
export function createWindowFocusPlugin(): Plugin {
  let focused = false
  return new Plugin({
    key: new PluginKey('windowFocus'),
    view: (view) => {
      focused = view.hasFocus()
      return {}
    },
    props: {
      handleDOMEvents: {
        blur: (view) => {
          if (!view.dom.ownerDocument.hasFocus()) return true
          focused = false
          return false
        },
        focus: () => {
          const again = focused
          focused = true
          return again
        }
      }
    }
  })
}
