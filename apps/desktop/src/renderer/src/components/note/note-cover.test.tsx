/**
 * `NoteCover` resolves a note-relative ref for rendering only.
 *
 * The resolved `memry-file://` URL carries this machine's vault path. Anywhere
 * it lands other than `src` is a path this machine could write back into the
 * note's frontmatter, from where it would sync to devices that resolve it to
 * nothing — so the DOM is swept, not just the image.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

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
  const { container } = render(
    <NoteCover
      cover={COVER_REF}
      noteId={NOTE_ID}
      notePath={NOTE_PATH}
      onChange={onChange}
      onRemove={onRemove}
      {...overrides}
    />
  )
  return { container, onChange, onRemove }
}

const changeButton = () => screen.getByRole('button', { name: 'Change cover' })
const removeButton = () => screen.getByRole('button', { name: 'Remove cover' })

describe('NoteCover', () => {
  it('paints the resolved memry-file URL and names the image from i18n', () => {
    renderCover()

    const image = screen.getByRole('img', { name: 'Cover image' })
    expect(image).toHaveAttribute('src', EXPECTED_SRC)
    expect(image.getAttribute('alt')).toBe('Cover image')
  })

  it('leaves a cover that already carries a scheme untouched', () => {
    renderCover({ cover: 'https://cdn.example.com/hero.webp' })

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/hero.webp')
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
    expect(onChange).toHaveBeenCalledTimes(1)

    const args = [...onChange.mock.calls, ...onRemove.mock.calls].flat()
    expect(
      args.filter((arg) => typeof arg === 'string'),
      'a ref escaping here would be written back to the vault file'
    ).toEqual([])
    expect(within(container).getByTestId('note-cover')).toBeInTheDocument()
  })

  it('disables both buttons when disabled', async () => {
    const { onChange, onRemove } = renderCover({ disabled: true })

    expect(changeButton()).toBeDisabled()
    expect(removeButton()).toBeDisabled()

    await userEvent.click(changeButton(), { pointerEventsCheck: 0 })
    await userEvent.click(removeButton(), { pointerEventsCheck: 0 })

    expect(onChange).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
  })
})
