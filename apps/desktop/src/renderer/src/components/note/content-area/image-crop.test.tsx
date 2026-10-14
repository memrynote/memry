import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defaultBlockSpecs } from '@blocknote/core'
import { withImageCropView } from './image-crop-view'
import { ImageCropDialog } from './image-crop-dialog'

const spec = withImageCropView(defaultBlockSpecs.image) as unknown as {
  implementation: {
    render: (block: unknown, editor: unknown) => { dom: HTMLElement }
  }
}

function renderImage(name: string) {
  const block = {
    id: 'img-1',
    type: 'image',
    props: {
      backgroundColor: 'default',
      textAlignment: 'left',
      name,
      url: 'file:///cat.png',
      caption: '',
      showPreview: true,
      previewWidth: 300
    },
    content: undefined,
    children: []
  }
  const editor = {
    isEditable: true,
    dictionary: { file_blocks: { add_button_text: { image: 'Add image' } } },
    updateBlock: () => {}
  }
  const output = spec.implementation.render(block, editor)
  document.body.appendChild(output.dom)
  return output.dom
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('image crop view', () => {
  it('shows only the cropped rectangle of the full picture', () => {
    const dom = renderImage('cat.png|crop=25,10,50,40')
    const box = dom.querySelector<HTMLElement>('.memry-image-crop')!
    const image = box.querySelector<HTMLImageElement>('img')!

    expect(image.getAttribute('src')).toBe('file:///cat.png')
    expect(image.alt).toBe('cat.png')
    expect(box.style.overflow).toBe('hidden')
    expect(image.style.width).toBe('200%')
    expect(image.style.height).toBe('250%')
    expect(image.style.left).toBe('-50%')
    expect(image.style.top).toBe('-25%')
  })

  it('leaves an uncropped image as it was', () => {
    const dom = renderImage('cat.png')
    expect(dom.querySelector('.memry-image-crop')).toBeNull()
    expect(dom.querySelector('img')!.style.position).toBe('')
  })
})

describe('ImageCropDialog', () => {
  function stageAt(width: number, height: number) {
    const stage = screen.getByTestId('image-crop-stage')
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect
    stage.setPointerCapture = () => {}
    return stage
  }

  it('applies the rectangle dragged over the picture', () => {
    const onApply = vi.fn()
    render(
      <ImageCropDialog
        src="file:///cat.png"
        name="cat.png"
        crop={null}
        onOpenChange={() => {}}
        onApply={onApply}
      />
    )
    const stage = stageAt(200, 100)
    fireEvent.pointerDown(stage, { button: 0, clientX: 20, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 120, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(stage, { pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Crop' }))

    expect(onApply).toHaveBeenCalledWith({ x: 10, y: 10, w: 50, h: 50 })
  })

  it('removes the crop when reset to the whole picture', () => {
    const onApply = vi.fn()
    render(
      <ImageCropDialog
        src="file:///cat.png"
        name="cat.png"
        crop={{ x: 10, y: 10, w: 50, h: 50 }}
        onOpenChange={() => {}}
        onApply={onApply}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show whole image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Crop' }))

    expect(onApply).toHaveBeenCalledWith(null)
  })
})
