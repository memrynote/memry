import { afterEach, describe, expect, it } from 'vitest'
import { defaultBlockSpecs } from '@blocknote/core'
import { withImageCornerHandles } from './image-corner-handles'

const spec = withImageCornerHandles(defaultBlockSpecs.image) as unknown as {
  implementation: {
    render: (block: unknown, editor: unknown) => { dom: HTMLElement; destroy?: () => void }
  }
}

function imageBlock(textAlignment = 'left') {
  return {
    id: 'img-1',
    type: 'image',
    props: {
      backgroundColor: 'default',
      textAlignment,
      name: 'cat.png',
      url: 'file:///cat.png',
      caption: '',
      showPreview: true,
      previewWidth: 300
    },
    content: undefined,
    children: []
  }
}

function mount(textAlignment?: string) {
  const block = imageBlock(textAlignment)
  const updates: unknown[] = []
  const editor = {
    isEditable: true,
    dictionary: { file_blocks: { add_button_text: { image: 'Add image' } } },
    updateBlock: (_target: unknown, update: unknown) => updates.push(update)
  }
  const output = spec.implementation.render(block, editor)
  document.body.appendChild(output.dom)
  const media = output.dom.querySelector<HTMLElement>('.bn-visual-media-wrapper')!
  // jsdom lays nothing out: put the picture at x 100..400.
  media.getBoundingClientRect = () => ({ left: 100, width: 300 }) as DOMRect
  Object.defineProperty(media.parentElement!, 'clientWidth', { value: 300 })
  const corner = (name: string) =>
    output.dom.querySelector<HTMLElement>(`.memry-image-corner-handle[data-corner="${name}"]`)!
  return { output, updates, corner }
}

function drag(handle: HTMLElement, fromX: number, toX: number): void {
  handle.dispatchEvent(
    new MouseEvent('mousedown', { clientX: fromX, bubbles: true, cancelable: true })
  )
  document.body.dispatchEvent(new MouseEvent('mousemove', { clientX: toX, bubbles: true }))
  document.body.dispatchEvent(new MouseEvent('mouseup', { clientX: toX, bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('image corner grips (#2696)', () => {
  it('adds four corner grips and keeps both side grips', () => {
    const { output } = mount()
    expect(output.dom.querySelectorAll('.bn-resize-handle')).toHaveLength(2)
    const corners = [...output.dom.querySelectorAll<HTMLElement>('.memry-image-corner-handle')]
    expect(corners.map((c) => c.dataset.corner)).toEqual([
      'top-start',
      'top-end',
      'bottom-start',
      'bottom-end'
    ])
    // Never the start of a marquee selection.
    for (const corner of corners) expect(corner.hasAttribute('data-marquee-ignore')).toBe(true)
  })

  it('widens from an end corner into the same previewWidth prop as the side grip', () => {
    const { corner, updates } = mount()
    drag(corner('bottom-end'), 400, 450)
    expect(updates).toEqual([{ props: { previewWidth: 350 } }])
  })

  it('drives the left grip from a left corner, so dragging outward widens', () => {
    const { corner, updates } = mount()
    drag(corner('top-start'), 100, 60)
    expect(updates).toEqual([{ props: { previewWidth: 340 } }])
  })

  it('keeps the side grip floor', () => {
    const { corner, updates } = mount()
    drag(corner('bottom-end'), 400, 0)
    expect(updates).toEqual([{ props: { previewWidth: 64 } }])
  })

  it('removes the corners on destroy', () => {
    const { output } = mount()
    output.destroy?.()
    expect(output.dom.querySelectorAll('.memry-image-corner-handle')).toHaveLength(0)
  })
})
