import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { EmojiPicker } from './EmojiPicker'

// emoji-mart renders a heavy DOM tree that jsdom does not need for layout assertions.
vi.mock('@emoji-mart/react', () => ({
  default: () => <div data-testid="emoji-grid" style={{ height: 435 }} />
}))
vi.mock('@emoji-mart/data', () => ({ default: {} }))

let i18n: I18nInstance

beforeAll(async () => {
  i18n = await createRendererI18n({ locale: 'en' })
})

const renderPicker = (props: Partial<React.ComponentProps<typeof EmojiPicker>> = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <EmojiPicker
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        hasEmoji={false}
        {...props}
      />
    </I18nextProvider>
  )

describe('EmojiPicker layout', () => {
  it('caps the embedded panel to the room the popover measured so the tabs stay visible', () => {
    renderPicker({ embedded: true })

    const panel = screen.getByRole('dialog')
    expect(panel.className).toContain('max-h-(--radix-popover-content-available-height)')
    expect(panel.className).toContain('flex-col')
    expect(panel.className).toContain('overflow-hidden')
  })

  it('keeps the tab bar from shrinking and lets the grid scroll instead', () => {
    renderPicker({ embedded: true })

    const tabBar = screen.getByRole('button', { name: 'Emoji' }).parentElement
    expect(tabBar?.className).toContain('shrink-0')

    const grid = screen.getByTestId('emoji-grid').parentElement
    expect(grid?.className).toContain('overflow-y-auto')
    expect(grid?.className).toContain('min-h-0')
  })

  it('keeps the remove row pinned outside the scroll area', () => {
    renderPicker({ embedded: true, hasEmoji: true })

    const removeRow = screen.getByRole('button', { name: /remove/i }).parentElement
    expect(removeRow?.className).toContain('shrink-0')
  })

  it('does not constrain the free-floating (non-embedded) panel', () => {
    renderPicker()

    const panel = screen.getByRole('dialog')
    expect(panel.className).not.toContain('max-h-')
    expect(panel.className).toContain('absolute')
  })
})
