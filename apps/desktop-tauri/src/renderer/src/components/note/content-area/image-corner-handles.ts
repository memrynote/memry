import type { defaultBlockSpecs } from '@blocknote/core'

type ImageBlockSpec = typeof defaultBlockSpecs.image

export const IMAGE_CORNERS = ['top-start', 'top-end', 'bottom-start', 'bottom-end'] as const

/**
 * Corner grips for an image block (#2696).
 *
 * BlockNote draws one width grip on each side of an image, and users looked
 * for the corners first. A corner does not get its own resize logic: on press
 * it hands the press to the side grip on its own side, so the drag is
 * BlockNote's — width only, height following the picture (aspect locked), the
 * same 64px floor and column cap, and the same `previewWidth` prop on release.
 * Nothing new is stored.
 *
 * The side is decided from where the press lands, not from the corner's name,
 * so a right-to-left note (where `start` is the right edge) still drives the
 * right grip from the right corners.
 */
export function withImageCornerHandles(spec: ImageBlockSpec): ImageBlockSpec {
  const { render } = spec.implementation
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(block, editor) {
        const output = render.call(this, block, editor)
        const sideHandles = output.dom.querySelectorAll<HTMLElement>('.bn-resize-handle')
        // BlockNote appends left then right; no preview means no grips at all.
        if (sideHandles.length !== 2) return output
        const [left, right] = sideHandles
        const container = left.parentElement
        if (!container) return output

        const forward = (event: MouseEvent | TouchEvent): void => {
          const point = 'touches' in event ? event.touches[0] : event
          if (!point) return
          event.preventDefault()
          event.stopPropagation()
          const box = container.getBoundingClientRect()
          const target = point.clientX < box.left + box.width / 2 ? left : right
          if ('touches' in event) {
            target.dispatchEvent(
              new TouchEvent('touchstart', {
                touches: Array.from(event.touches),
                bubbles: true,
                cancelable: true
              })
            )
          } else {
            target.dispatchEvent(
              new MouseEvent('mousedown', {
                clientX: point.clientX,
                clientY: point.clientY,
                button: event.button,
                bubbles: true,
                cancelable: true
              })
            )
          }
        }

        const corners = IMAGE_CORNERS.map((corner) => {
          const handle = document.createElement('div')
          handle.className = 'memry-image-corner-handle'
          handle.dataset.corner = corner
          // A press here is a resize, never the start of a marquee selection.
          handle.dataset.marqueeIgnore = ''
          // Pointer-only, like BlockNote's side grips; keyboard resizing is
          // unchanged by this.
          handle.setAttribute('aria-hidden', 'true')
          handle.addEventListener('mousedown', forward)
          handle.addEventListener('touchstart', forward, { passive: false })
          // After the side grips, so `.bn-resize-handle ~` in base.css can
          // mirror their visibility.
          container.appendChild(handle)
          return handle
        })

        return {
          ...output,
          destroy: () => {
            for (const handle of corners) {
              handle.removeEventListener('mousedown', forward)
              handle.removeEventListener('touchstart', forward)
              handle.remove()
            }
            output.destroy?.()
          }
        }
      }
    }
  }
}
