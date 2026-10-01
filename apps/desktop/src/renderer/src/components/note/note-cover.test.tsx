/**
 * `NoteCover` resolves a note-relative ref for rendering only, and never paints
 * a broken image.
 *
 * The resolved `memry-file://` URL carries this machine's vault path. Anywhere
 * it lands other than `src` is a path this machine could write back into the
 * note's frontmatter, from where it would sync to devices that resolve it to
 * nothing — so the DOM is swept, not just the image.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COVER_FRAMING,
  coverWashForSeed,
  coverWashGradient
} from '@memry/shared/cover-image'

const VAULT_PATH = vi.hoisted(() => '/Users/kaan/Vault')

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({ vaultPath: VAULT_PATH })
}))

import { NoteCover, type NoteCoverProps } from './note-cover'

const NOTE_ID = 'nte_9f2c1a'
const NOTE_PATH = 'notes/Books/Dune.md'
const COVER_REF = `../../attachments/${NOTE_ID}/abc123-photo.jpg`
const EXPECTED_SRC = `memry-file://local${VAULT_PATH}/attachments/${NOTE_ID}/abc123-photo.jpg`

function renderCover(overrides: Partial<NoteCoverProps> = {}) {
  const onChange = vi.fn()
  const onRemove = vi.fn()
  const onFramingChange = vi.fn()
  const onRepositioningChange = vi.fn()
  const result = render(
    <NoteCover
      cover={{ kind: 'image', ref: COVER_REF }}
      noteId={NOTE_ID}
      notePath={NOTE_PATH}
      framing={DEFAULT_COVER_FRAMING}
      onChange={onChange}
      onRemove={onRemove}
      onFramingChange={onFramingChange}
      onRepositioningChange={onRepositioningChange}
      {...overrides}
    />
  )
  return { ...result, onChange, onRemove, onFramingChange, onRepositioningChange }
}

const changeButton = () => screen.getByRole('button', { name: 'Change cover' })
const removeButton = () => screen.getByRole('button', { name: 'Remove cover' })
const band = () => screen.getByTestId('note-cover')

describe('NoteCover image covers', () => {
  it('paints the resolved memry-file URL and names the image from i18n', () => {
    renderCover()

    const image = screen.getByRole('img', { name: 'Cover image' })
    expect(image).toHaveAttribute('src', EXPECTED_SRC)
  })

  it('leaves a cover that already carries a scheme untouched', () => {
    renderCover({ cover: { kind: 'image', ref: 'https://cdn.example.com/hero.webp' } })

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/hero.webp')
  })

  it('positions the image at the stored focus', () => {
    renderCover({ framing: { ...DEFAULT_COVER_FRAMING, focusY: 18 } })

    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 18%' })
  })

  it('renders a note without framing keys exactly as before: centred, unzoomed, 200px', () => {
    renderCover()

    expect(band()).toHaveStyle({ height: '200px' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 50%' })
    expect(screen.getByRole('img').style.transform).toBe('')
  })

  it('applies the stored focal point, zoom and height', () => {
    renderCover({ framing: { focusX: 70, focusY: 30, zoom: 1.5, height: 320 } })

    expect(band()).toHaveStyle({ height: '320px' })
    expect(screen.getByRole('img')).toHaveStyle({
      objectPosition: '70% 30%',
      transform: 'scale(1.5)',
      transformOrigin: '70% 30%'
    })
  })

  it('keeps the stored height on a wash', () => {
    renderCover({
      cover: { kind: 'wash', id: 'sage' },
      framing: { ...DEFAULT_COVER_FRAMING, height: 260 }
    })

    expect(band()).toHaveStyle({ height: '260px' })
  })

  it('keeps the raw ref out of the DOM entirely', () => {
    const { container } = renderCover()

    expect(container.innerHTML).not.toContain(COVER_REF)
    expect(container.innerHTML).not.toContain('../')
  })

  it('lets the resolved URL reach the src attribute and nothing else', () => {
    const { container } = renderCover()

    const carriers: string[] = []
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === 'src' && element.tagName === 'IMG') continue
        if (attribute.value.includes(EXPECTED_SRC)) {
          carriers.push(`${element.tagName}[${attribute.name}]`)
        }
      }
    }
    expect(carriers).toEqual([])
    expect(container.textContent).not.toContain(EXPECTED_SRC)
    expect(container.textContent).not.toContain(VAULT_PATH)
  })

  it('exposes change and remove as real focusable buttons that fire their callbacks', async () => {
    const { container, onChange, onRemove } = renderCover()

    for (const button of [changeButton(), removeButton()]) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      button.focus()
      expect(button).toHaveFocus()
    }

    await userEvent.click(changeButton())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onRemove).not.toHaveBeenCalled()

    await userEvent.click(removeButton())
    expect(onRemove).toHaveBeenCalledTimes(1)

    const args = [...onChange.mock.calls, ...onRemove.mock.calls].flat()
    expect(
      args.filter((arg) => typeof arg === 'string'),
      'a ref escaping here would be written back to the vault file'
    ).toEqual([])
    expect(within(container).getByTestId('note-cover')).toBeInTheDocument()
  })

  it('disables change and remove when disabled', async () => {
    const { onChange, onRemove } = renderCover({ disabled: true })

    expect(changeButton()).toBeDisabled()
    expect(removeButton()).toBeDisabled()

    await userEvent.click(changeButton(), { pointerEventsCheck: 0 })
    await userEvent.click(removeButton(), { pointerEventsCheck: 0 })

    expect(onChange).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
  })
})

describe('NoteCover wash covers', () => {
  it('paints the gradient rather than an img, and offers no reposition', () => {
    renderCover({ cover: { kind: 'wash', id: 'plum' } })

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByTestId('note-cover-wash')).toHaveStyle({
      backgroundImage: coverWashGradient('plum')
    })
    expect(screen.queryByRole('button', { name: 'Reposition' })).not.toBeInTheDocument()
    expect(band()).toHaveAttribute('data-cover-kind', 'wash')
  })

  it('falls back to a wash derived from the note id when the image fails to load', () => {
    renderCover()

    fireEvent.error(screen.getByRole('img'))

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByTestId('note-cover-wash')).toHaveStyle({
      backgroundImage: coverWashGradient(coverWashForSeed(NOTE_ID))
    })
  })

  it('retries a different cover rather than inheriting the previous failure', () => {
    const { rerender } = renderCover()
    fireEvent.error(screen.getByRole('img'))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    rerender(
      <NoteCover
        cover={{ kind: 'image', ref: 'https://cdn.example.com/other.webp' }}
        noteId={NOTE_ID}
        notePath={NOTE_PATH}
        framing={DEFAULT_COVER_FRAMING}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onFramingChange={vi.fn()}
      />
    )
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/other.webp')
  })
})

describe('NoteCover credit', () => {
  it('shows the credit only when both the name and an http(s) URL are present', () => {
    const { rerender } = renderCover({
      credit: 'Ana Ruiz',
      creditUrl: 'https://unsplash.com/@ana'
    })

    const link = screen.getByTestId('note-cover-credit')
    expect(link).toHaveTextContent('Photo by Ana Ruiz on Unsplash')
    expect(link).toHaveAttribute('href', 'https://unsplash.com/@ana')

    rerender(
      <NoteCover
        cover={{ kind: 'image', ref: COVER_REF }}
        noteId={NOTE_ID}
        notePath={NOTE_PATH}
        framing={DEFAULT_COVER_FRAMING}
        credit="Ana Ruiz"
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onFramingChange={vi.fn()}
      />
    )
    expect(screen.queryByTestId('note-cover-credit')).not.toBeInTheDocument()
  })
})

describe('NoteCover reposition', () => {
  it('swaps the toolbar for the drag hint and nudges the focus by two', () => {
    const { onFramingChange, onRepositioningChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 50 }
    })

    expect(screen.getByTestId('note-cover-reposition-hint')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change cover' })).not.toBeInTheDocument()

    fireEvent.keyDown(band(), { key: 'ArrowUp' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 48%' })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 52%' })

    fireEvent.keyDown(band(), { key: 'Enter' })
    expect(onFramingChange).toHaveBeenCalledWith({ focusY: 52 })
    expect(onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('drops the drag on escape without writing the note', () => {
    const { onFramingChange, onRepositioningChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 30 }
    })

    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 32%' })

    fireEvent.keyDown(band(), { key: 'Escape' })
    expect(onFramingChange).not.toHaveBeenCalled()
    expect(onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('saves and cancels from the pill, not the keyboard alone', () => {
    const saved = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 40 }
    })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('note-cover-reposition-save'))
    expect(saved.onFramingChange).toHaveBeenCalledWith({ focusY: 42 })
    expect(saved.onRepositioningChange).toHaveBeenCalledWith(false)

    cleanup()

    const dropped = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 40 }
    })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('note-cover-reposition-cancel'))
    expect(dropped.onFramingChange).not.toHaveBeenCalled()
    expect(dropped.onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('saves and leaves reposition when focus moves off the band', () => {
    const { onFramingChange, onRepositioningChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 40 }
    })

    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    fireEvent.blur(band(), { relatedTarget: document.body })

    expect(onFramingChange).toHaveBeenCalledWith({ focusY: 42 })
    expect(onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('stays in reposition while focus moves inside the band', () => {
    const { onRepositioningChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusY: 40 }
    })

    fireEvent.blur(band(), { relatedTarget: screen.getByRole('img') })

    expect(onRepositioningChange).not.toHaveBeenCalled()
  })

  it('pans horizontally with left and right', () => {
    const { onFramingChange } = renderCover({ repositioning: true })

    fireEvent.keyDown(band(), { key: 'ArrowLeft' })
    fireEvent.keyDown(band(), { key: 'ArrowLeft' })
    fireEvent.keyDown(band(), { key: 'ArrowRight' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '48% 50%' })

    fireEvent.keyDown(band(), { key: 'Enter' })
    expect(onFramingChange).toHaveBeenCalledWith({ focusX: 48 })
  })

  it('zooms around the focal point from the pill and the keyboard, within 1..3', () => {
    const { onFramingChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, focusX: 30, focusY: 60 }
    })

    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByRole('img').style.transform).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.keyDown(band(), { key: '+' })
    fireEvent.keyDown(band(), { key: '=' })
    fireEvent.keyDown(band(), { key: '-' })
    expect(screen.getByRole('img')).toHaveStyle({
      transform: 'scale(1.2)',
      transformOrigin: '30% 60%'
    })
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute(
      'aria-disabled',
      'false'
    )

    fireEvent.click(screen.getByTestId('note-cover-reposition-save'))
    expect(onFramingChange).toHaveBeenCalledWith({ zoom: 1.2 })
  })

  it('resizes the band with shift and the arrows, within its bounds', () => {
    const { onFramingChange } = renderCover({
      repositioning: true,
      framing: { ...DEFAULT_COVER_FRAMING, height: 128 }
    })

    fireEvent.keyDown(band(), { key: 'ArrowUp', shiftKey: true })
    fireEvent.keyDown(band(), { key: 'ArrowUp', shiftKey: true })
    expect(band()).toHaveStyle({ height: '120px' })
    fireEvent.keyDown(band(), { key: 'ArrowDown', shiftKey: true })
    expect(band()).toHaveStyle({ height: '128px' })
    // Shift moved the edge, not the focal point.
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 50%' })

    fireEvent.keyDown(band(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(band(), { key: 'Enter' })
    expect(onFramingChange).toHaveBeenCalledWith({ height: 136 })
  })

  it('sets the height from the dragged bottom edge without moving the focal point', () => {
    renderCover({ repositioning: true })
    const handle = screen.getByTestId('note-cover-resize-handle')
    vi.spyOn(band(), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 100, width: 800, height: 200 })
    )
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 420 })

    expect(band()).toHaveStyle({ height: '320px' })
    expect(handle).toHaveAttribute('aria-valuenow', '320')
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 50%' })
  })

  it('offers no zoom or resize outside reposition', () => {
    renderCover()

    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('note-cover-resize-handle')).not.toBeInTheDocument()
  })

  it('never enters reposition for a wash', () => {
    renderCover({ cover: { kind: 'wash', id: 'sage' }, repositioning: true })

    expect(screen.queryByTestId('note-cover-reposition-hint')).not.toBeInTheDocument()
    expect(band()).not.toHaveAttribute('data-repositioning')
  })
})
