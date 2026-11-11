import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

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
 * #3967). One plugin instance per editor. The plugin keeps its own flag because
 * ProseMirror's `view.focused` is internal and not in its type declarations.
 *
 * A swallowed blur is checked again once the document has focus: a frame after
 * the blur (focus that went into an embed's iframe can blur the editor before
 * the document reports focus) and a frame after the window comes back (a dialog
 * that closed in the background moved focus with `.focus()`, which blurs
 * nothing a second time). If the editor no longer holds focus then, the blur
 * was a move inside the app, and it is replayed so the menu closes (#4244).
 */
export function createWindowFocusPlugin(): Plugin {
  let blurredByWindow = false
  const recheckNextFrame = (view: EditorView): void => {
    requestAnimationFrame(() => {
      if (blurredByWindow && view.dom.ownerDocument.hasFocus() && !view.hasFocus()) {
        view.dom.dispatchEvent(new FocusEvent('blur'))
      }
    })
  }
  return new Plugin({
    key: new PluginKey('windowFocus'),
    view: (view) => {
      const win = view.dom.ownerDocument.defaultView
      const onWindowFocus = (): void => recheckNextFrame(view)
      win?.addEventListener('focus', onWindowFocus)
      return { destroy: () => win?.removeEventListener('focus', onWindowFocus) }
    },
    props: {
      handleDOMEvents: {
        blur: (view) => {
          blurredByWindow = !view.dom.ownerDocument.hasFocus()
          if (blurredByWindow) recheckNextFrame(view)
          return blurredByWindow
        },
        focus: () => blurredByWindow
      }
    }
  })
}
