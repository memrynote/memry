/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The editor flavour of `inlineImage` — presentation, and the resize grip.
 *
 * The config, `parse` and `toExternalHTML` — everything that decides what
 * reaches the vault file — live in @memry/editor-schema, so the main process
 * registers the identical node instead of deleting it out of the shared Y.Doc.
 *
 * Two things are added here, and both are gated on `renderType === 'nodeView'`
 * for the same reason: BlockNote reaches this exact function with
 * `renderType: 'dom'` when it SERIALIZES a table cell, and reads the element it
 * gets back.
 *
 *   - a note-relative `src` is resolved to something the renderer can load. An
 *     `<img src>` carrying this machine's absolute vault path is what must never
 *     be written back to disk.
 *   - the width rides in the alt text on the way out (`name|300`, see
 *     `serializeInlineImageAlt`) but is a real `style.width` in the editor, so a
 *     screen reader is never read a number that is really a layout instruction.
 */

import {
  createInlineImageContent,
  createInlineImageSpec,
  serializeInlineImageAlt,
  toWidth
} from '@memry/editor-schema/inline'

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows. Mirrors the resolver. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/** Below this a cell image is a smudge with no grip left to drag. */
const MIN_WIDTH = 24

/**
 * Applies an explicit width, and lifts the CSS height cap with it.
 *
 * The cap (`max-height: 8em`) is what keeps an un-sized screenshot from blowing
 * a row's height out. Once someone has dragged a width, that cap would silently
 * override them — the picture would refuse to grow past eight lines and the
 * grip would look broken.
 */
function applyWidth(img: HTMLImageElement, width: number): void {
  if (width > 0) {
    img.style.width = `${width}px`
    img.style.maxHeight = 'none'
  } else {
    img.style.removeProperty('width')
    img.style.removeProperty('max-height')
  }
}

/**
 * The drag grip on the picture's inline-end edge.
 *
 * `pointerdown` is swallowed so ProseMirror does not read the drag as a text
 * selection or start dragging the node itself, and the pointer is captured so
 * the gesture survives leaving the 10px strip. Only `pointerup` commits: a
 * write per `pointermove` would put one undo entry on the stack per pixel and
 * send a CRDT update with it.
 */
function attachResizeGrip(
  wrap: HTMLElement,
  img: HTMLImageElement,
  commit: (width: number) => void
): void {
  const grip = document.createElement('span')
  grip.className = 'inline-image-grip'
  grip.contentEditable = 'false'
  grip.setAttribute('aria-hidden', 'true')

  grip.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = img.getBoundingClientRect().width
    // The grip sits on the inline-end edge, which is the LEFT edge in RTL — so
    // there "wider" is a drag towards smaller clientX.
    const towards = getComputedStyle(img).direction === 'rtl' ? -1 : 1
    grip.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent): void => {
      applyWidth(
        img,
        Math.max(MIN_WIDTH, Math.round(startWidth + (move.clientX - startX) * towards))
      )
    }
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeEventListener('pointercancel', onUp)
      commit(Math.round(img.getBoundingClientRect().width))
    }

    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
  })

  wrap.appendChild(grip)
}

/**
 * Exported for its own test. BlockNote wraps whatever is handed to
 * `createInlineImageSpec`, and the wrapper calls it without a `this`, so the
 * `nodeView` branch below is only reachable through the real editor — or
 * through this reference.
 */
export function renderInlineImage(
  this: any,
  inlineContent: any,
  updateInlineContent: (content: any) => void,
  editor: any
) {
  const src = String(inlineContent.props.src || '')
  const alt = String(inlineContent.props.alt || '')
  const width = toWidth(inlineContent.props.width)

  const img = document.createElement('img')
  img.className = 'inline-image'
  // The on-disk value goes on first and unconditionally: the serializer reads
  // this element, so whatever is on it at that moment is what lands in markdown.
  img.setAttribute('src', src)
  img.setAttribute('draggable', 'false')
  img.contentEditable = 'false'

  if (this?.renderType !== 'nodeView') {
    // Serialization and the clipboard: the alt carries the width, and there is
    // no wrapper or grip to serialize into the cell.
    //
    // Not the path that writes the vault file — with collaboration live that is
    // the MAIN process's copy of this spec (@memry/editor-schema/server), so a
    // mutation here does not turn the E2E red. What it does own is copy-out: an
    // inline image copied to the clipboard keeps its size.
    img.setAttribute('alt', serializeInlineImageAlt(alt, width))
    return { dom: img }
  }

  img.setAttribute('alt', alt)
  applyWidth(img, width)

  const resolve = editor?.resolveFileUrl
  if (src && !HAS_SCHEME.test(src) && resolve) {
    void Promise.resolve(resolve(src))
      .then((resolved: string) => {
        if (resolved) img.setAttribute('src', resolved)
      })
      .catch(() => {
        /* leave the unresolved ref in place — a broken image is honest here */
      })
  }

  const wrap = document.createElement('span')
  wrap.className = 'inline-image-wrap'
  wrap.contentEditable = 'false'
  wrap.appendChild(img)
  attachResizeGrip(wrap, img, (next) =>
    updateInlineContent(createInlineImageContent(src, alt, next))
  )

  return { dom: wrap }
}

export const InlineImage = createInlineImageSpec(renderInlineImage)
