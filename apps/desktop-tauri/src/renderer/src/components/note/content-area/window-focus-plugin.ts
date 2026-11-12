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
 * #3967). A focus while the editor already counts as focused is swallowed as
 * well: a window coming to the front over an editor that took focus while it
 * was in the background sends one with no window blur before it (CI, #3967).
 * That editor may never have seen a `focus` either: `.focus()` or a click while
 * another app's window holds OS focus moves DOM focus with no event, and a
 * suggestion menu opened then closed on the window's first `focus` (FLAKE-7C,
 * #3967). So key input reaching the editor while the document has no focus, or
 * the editor being the active element when the window comes back (the window's
 * `focus` fires before the element's), also counts the editor as focused.
 * One plugin instance per editor. The plugin keeps its own flags because
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
  let focused = false
  const recheckNextFrame = (view: EditorView): void => {
    requestAnimationFrame(() => {
      if (blurredByWindow && view.dom.ownerDocument.hasFocus() && !view.hasFocus()) {
        view.dom.dispatchEvent(new FocusEvent('blur'))
      }
    })
  }
  const keyInputInBackground = (view: EditorView): boolean => {
    if (!view.dom.ownerDocument.hasFocus()) focused = true
    return false
  }
  return new Plugin({
    key: new PluginKey('windowFocus'),
    view: (view) => {
      focused = view.hasFocus()
      const win = view.dom.ownerDocument.defaultView
      const onWindowFocus = (): void => {
        if (view.hasFocus()) focused = true
        recheckNextFrame(view)
      }
      win?.addEventListener('focus', onWindowFocus)
      return { destroy: () => win?.removeEventListener('focus', onWindowFocus) }
    },
    props: {
      handleDOMEvents: {
        blur: (view) => {
          blurredByWindow = !view.dom.ownerDocument.hasFocus()
          if (blurredByWindow) recheckNextFrame(view)
          else focused = false
          return blurredByWindow
        },
        keydown: keyInputInBackground,
        beforeinput: keyInputInBackground,
        focus: () => {
          const again = blurredByWindow || focused
          focused = true
          return again
        }
      }
    }
  })
}
