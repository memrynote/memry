import { requestAsset } from './assets.ts'

/**
 * Resolve every `<img>` the editor renders (T072/T073).
 *
 * Images in a note carry a VAULT-RELATIVE reference — `attachments/<noteId>/…`
 * — because that is what the file on disk says and what desktop resolves. The
 * WebView cannot read the vault, and its CSP allows `img-src data: blob:`
 * only, so a relative `src` renders as a broken image no matter which block
 * produced it.
 *
 * This is a DOM-level resolver rather than a per-spec `render` override on
 * purpose: BlockNote emits `<img>` from the default `image` block, from the
 * custom `inlineImage` spec, from `bookmark`/`youtubeEmbed` markers and from
 * pasted HTML. Overriding one spec fixes one of them; watching the container
 * fixes all of them, and it leaves every block's on-disk form untouched —
 * `src` is only ever swapped in the live DOM, never in the document.
 *
 * A `pending` answer (the file is not downloaded yet, which is normal under
 * the Wi-Fi-only default) leaves the placeholder up and re-asks on a bounded
 * backoff, so a late download appears without recreating the note.
 */

const RESOLVED_ATTR = 'data-asset-resolved'
const REF_ATTR = 'data-asset-ref'

/** Re-ask for pending refs on this schedule, then stop. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 45_000]

function isAlreadyRenderable(src: string): boolean {
  return src.startsWith('data:') || src.startsWith('blob:')
}

export function installImageResolver(root: HTMLElement): () => void {
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** Refs the host reported as gone; retrying those cannot change the answer. */
  const missing = new Set<string>()

  const resolve = (img: HTMLImageElement, ref: string, attempt: number): void => {
    if (missing.has(ref)) {
      // Another element already learned this reference resolves to nothing;
      // a note full of the same dead ref costs one ask, not one per picture.
      img.classList.add('asset-missing')
      return
    }

    void requestAsset(ref).then((answer) => {
      if (disposed || !img.isConnected) return

      if (answer.status === 'ready') {
        img.classList.remove('asset-pending')
        img.setAttribute('src', answer.dataUri)
        img.setAttribute(RESOLVED_ATTR, '')
        return
      }

      if (answer.status === 'missing') {
        // The host looked and the blob is gone — retrying cannot change that.
        missing.add(ref)
        img.classList.add('asset-missing')
        return
      }

      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined) {
        // Out of retries. The placeholder stays rather than the broken-image
        // glyph: `pending` means the bytes exist somewhere, just not here yet.
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        resolve(img, ref, attempt + 1)
      }, delay)
      timers.add(timer)
    })
  }

  const claim = (img: HTMLImageElement): void => {
    if (img.hasAttribute(RESOLVED_ATTR)) return
    const src = img.getAttribute(REF_ATTR) ?? img.getAttribute('src') ?? ''
    if (src.length === 0 || isAlreadyRenderable(src)) return

    // The original reference is parked on the element so a later re-render (or
    // a retry) still knows what to ask for after `src` has been swapped.
    img.setAttribute(REF_ATTR, src)
    img.removeAttribute('src')
    img.classList.add('asset-pending')
    resolve(img, src, 0)
  }

  const scan = (node: Node): void => {
    if (node instanceof HTMLImageElement) claim(node)
    else if (node instanceof HTMLElement) {
      for (const img of node.querySelectorAll('img')) claim(img)
    }
  }

  scan(root)

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) scan(added)
      if (
        record.type === 'attributes' &&
        record.attributeName === 'src' &&
        record.target instanceof HTMLImageElement
      ) {
        claim(record.target)
      }
    }
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src']
  })

  return () => {
    disposed = true
    observer.disconnect()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
}
