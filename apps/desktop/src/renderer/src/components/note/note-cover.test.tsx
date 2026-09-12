/**
 * `NoteCover` resolves a note-relative ref for rendering only, and never paints
 * a broken image.
 *
 * The resolved `memry-file://` URL carries this machine's vault path. Anywhere
 * it lands other than `src` is a path this machine could write back into the
 * note's frontmatter, from where it would sync to devices that resolve it to
 * nothing — so the DOM is swept, not just the image.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { coverWashForSeed, coverWashGradient } from '@memry/shared/cover-image'

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
  const onFocusChange = vi.fn()
  const onRepositioningChange = vi.fn()
  const result = render(
    <NoteCover
      cover={{ kind: 'image', ref: COVER_REF }}
      noteId={NOTE_ID}
      notePath={NOTE_PATH}
      focus={50}
      onChange={onChange}
      onRemove={onRemove}
      onFocusChange={onFocusChange}
      onRepositioningChange={onRepositioningChange}
      {...overrides}
    />
  )
  return { ...result, onChange, onRemove, onFocusChange, onRepositioningChange }
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
    renderCover({ focus: 18 })

    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 18%' })
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
        focus={50}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onFocusChange={vi.fn()}
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
        focus={50}
        credit="Ana Ruiz"
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onFocusChange={vi.fn()}
      />
    )
    expect(screen.queryByTestId('note-cover-credit')).not.toBeInTheDocument()
  })
})

describe('NoteCover reposition', () => {
  it('swaps the toolbar for the drag hint and nudges the focus by two', () => {
    const { onFocusChange, onRepositioningChange } = renderCover({ repositioning: true, focus: 50 })

    expect(screen.getByTestId('note-cover-reposition-hint')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change cover' })).not.toBeInTheDocument()

    fireEvent.keyDown(band(), { key: 'ArrowUp' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 48%' })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 52%' })

    fireEvent.keyDown(band(), { key: 'Enter' })
    expect(onFocusChange).toHaveBeenCalledWith(52)
    expect(onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('restores the pre-drag focus on escape', () => {
    const { onFocusChange, onRepositioningChange } = renderCover({ repositioning: true, focus: 30 })

    fireEvent.keyDown(band(), { key: 'ArrowDown' })
    expect(screen.getByRole('img')).toHaveStyle({ objectPosition: '50% 32%' })

    fireEvent.keyDown(band(), { key: 'Escape' })
    expect(onFocusChange).toHaveBeenCalledWith(30)
    expect(onRepositioningChange).toHaveBeenCalledWith(false)
  })

  it('never enters reposition for a wash', () => {
    renderCover({ cover: { kind: 'wash', id: 'sage' }, repositioning: true })

    expect(screen.queryByTestId('note-cover-reposition-hint')).not.toBeInTheDocument()
    expect(band()).not.toHaveAttribute('data-repositioning')
  })
})
