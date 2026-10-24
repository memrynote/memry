/**
 * GhostAffordanceRow Tests
 *
 * Covers the note/journal "Add details" menu. Focused on
 * the `project` property-type guard: this row renders its own AddPropertyPopup
 * independent of InfoSection's, so the existingNames guard has to be threaded
 * through separately or a note can pick up a second, non-linking `project 2`.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GhostAffordanceRow } from './ghost-affordance-row'

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)

const defaultProps = {
  availableTags: [],
  recentTags: [],
  currentTagIds: [],
  onAddTag: vi.fn(),
  onCreateTag: vi.fn(),
  onAddProperty: vi.fn()
}

describe('GhostAffordanceRow - details menu', () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Add details' }))

  it('lists tag, property, name and cover, dropping entries without a handler', async () => {
    const user = userEvent.setup()
    const { rerender } = renderWithI18n(
      <GhostAffordanceRow {...defaultProps} onAddCover={vi.fn()} onAddName={vi.fn()} />
    )
    await openMenu(user)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Add tag',
      'Add property',
      'Add another name',
      'Add cover'
    ])
    await user.keyboard('{Escape}')

    rerender(
      <I18nextProvider i18n={i18nEn}>
        <GhostAffordanceRow {...defaultProps} hideAddTag />
      </I18nextProvider>
    )
    await openMenu(user)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Add property'
    ])
  })

  it('anchors the cover picker under the trigger', async () => {
    const user = userEvent.setup()
    const onAddCover = vi.fn()
    renderWithI18n(<GhostAffordanceRow {...defaultProps} onAddCover={onAddCover} />)

    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Add cover' }))
    expect(onAddCover).toHaveBeenCalledWith({ x: expect.any(Number), y: expect.any(Number) })
  })

  it('opens the tag picker from the menu', async () => {
    const user = userEvent.setup()
    renderWithI18n(<GhostAffordanceRow {...defaultProps} />)

    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Add tag' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('disables the trigger when the row is disabled', () => {
    renderWithI18n(<GhostAffordanceRow {...defaultProps} disabled />)
    expect(screen.getByRole('button', { name: 'Add details' })).toBeDisabled()
  })
})

describe('GhostAffordanceRow - project type guard', () => {
  it('disables the project entry when the note already has one', async () => {
    const user = userEvent.setup()
    renderWithI18n(<GhostAffordanceRow {...defaultProps} existingNames={['project']} />)

    await user.click(screen.getByRole('button', { name: 'Add details' }))
    await user.click(screen.getByRole('menuitem', { name: /add property/i }))

    expect(screen.getByRole('option', { name: /^project$/i })).toBeDisabled()
  })
})
