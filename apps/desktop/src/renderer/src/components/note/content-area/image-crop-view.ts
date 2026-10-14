import type { defaultBlockSpecs } from '@blocknote/core'
import { parseImageCrop, type ImageCrop } from '@memry/editor-schema/blocks'

type ImageBlockSpec = typeof defaultBlockSpecs.image

/**
 * Shows an image block through its crop (#3170).
 *
 * The `<img>` keeps the full attachment; a box with `overflow: hidden` shows
 * only the cropped rectangle. A sized block fills its width (the resize grips
 * keep working on the cropped view); an unsized one shows the crop at the
 * picture's natural scale, as an uncropped image would. The aspect ratio and
 * natural width need the loaded picture, so they are set again on load.
 */
export function applyImageCrop(
  image: HTMLImageElement,
  crop: ImageCrop,
  sized: boolean
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'memry-image-crop'
  box.dataset.testid = 'image-crop-box'
  box.style.position = 'relative'
  box.style.overflow = 'hidden'
  box.style.width = '100%'
  box.style.maxWidth = '100%'

  const setAspect = (): void => {
    const naturalW = image.naturalWidth || 1
    const naturalH = image.naturalHeight || 1
    box.style.aspectRatio = `${crop.w * naturalW} / ${crop.h * naturalH}`
    // Absolute positioning takes the picture out of the flow, so an unsized
    // block (its wrapper is `fit-content`) needs the box to carry the width.
    if (!sized && image.naturalWidth) box.style.width = `${(crop.w / 100) * naturalW}px`
  }
  setAspect()
  image.addEventListener('load', setAspect)

  image.style.position = 'absolute'
  image.style.maxWidth = 'none'
  image.style.width = `${(100 / crop.w) * 100}%`
  image.style.height = `${(100 / crop.h) * 100}%`
  image.style.left = `${(-crop.x / crop.w) * 100}%`
  image.style.top = `${(-crop.y / crop.h) * 100}%`

  image.replaceWith(box)
  box.appendChild(image)
  return box
}

export function withImageCropView(spec: ImageBlockSpec): ImageBlockSpec {
  const { render } = spec.implementation
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(block, editor) {
        const output = render.call(this, block, editor)
        const { name, crop } = parseImageCrop(block.props.name ?? '')
        const image = output.dom.querySelector<HTMLImageElement>('img.bn-visual-media')
        if (!image) return output
        // The crop suffix is storage, not a description of the picture.
        image.alt = name
        if (crop) applyImageCrop(image, crop, Boolean(block.props.previewWidth))
        return output
      }
    }
  }
}
