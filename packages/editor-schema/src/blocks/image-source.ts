import type { defaultBlockSpecs } from '@blocknote/core'

type ImageBlockSpec = typeof defaultBlockSpecs.image

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * An image block keeps a note-relative address as the author wrote it.
 *
 * BlockNote reads the address from the `src` property, which resolves a
 * relative ref (`assets/p.png`, `../attachments/x.png`) against the page's base
 * URL, and writing THAT back to disk is how a vault stops being portable
 * between machines. The main process parses under a DOM with no base URL, so it
 * already keeps the ref; this gives the renderer the same bytes. A cell image
 * does the same in `inlineImageSerialization`.
 */
export function withNoteRelativeImageSource(spec: ImageBlockSpec): ImageBlockSpec {
  const { parse } = spec.implementation
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      parse(element) {
        const props = parse?.(element)
        if (!props) return props
        const image = element.tagName === 'IMG' ? element : element.querySelector('img')
        const source = image?.getAttribute('src')?.trim()
        return source && !HAS_SCHEME.test(source) ? { ...props, url: source } : props
      }
    }
  }
}
