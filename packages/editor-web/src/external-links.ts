import type { GuestBridge } from './bridge.ts'

/**
 * External links in the WebView (#2096).
 *
 * Three shapes carry an external URL in a note, and none of them may navigate:
 *   * the default `link` style mark, a real `<a href>` BlockNote renders;
 *   * a `linkMention` chip, a `<span data-link-mention data-url>`;
 *   * a `bookmark` block, a `<div class="bookmark-block" data-url>`.
 *
 * The `<a>` was the one that appeared to work. `editor-host.tsx` pinned the
 * WebView's `originWhitelist` to `about:blank`, and react-native-webview hands
 * a blocked navigation to the OS — so a tapped link reached Safari as a SIDE
 * EFFECT of the hardening, with no allowlist between the note's bytes and
 * `Linking.openURL`. The host now refuses every navigation outright, and this
 * is the only way out of the document.
 *
 * `pointerup`, not `click`, for the reason the wiki-link chip uses it: the
 * chips are `contenteditable=false` and iOS can move the node out from under a
 * click. Flushing immediately keeps the tap off the 24 ms batching delay.
 */
export function installExternalLinks(root: HTMLElement, bridge: GuestBridge): () => void {
  const onPointerUp = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const anchor = target.closest('a[href]')
    const carrier = target.closest('[data-url]')
    const url =
      anchor instanceof HTMLAnchorElement
        ? anchor.getAttribute('href')?.trim()
        : carrier instanceof HTMLElement
          ? carrier.getAttribute('data-url')?.trim()
          : undefined
    if (!url) return

    event.preventDefault()
    bridge.send({ type: 'open-external', url })
    bridge.flush()
  }
  root.addEventListener('pointerup', onPointerUp)
  return () => root.removeEventListener('pointerup', onPointerUp)
}
