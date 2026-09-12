/**
 * GhostAffordanceRow Tests
 *
 * Covers the note/journal "ghost" add-tag/add-property affordance. Focused on
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

describe('GhostAffordanceRow - chips', () => {
  it('orders the chips cover, tag, properties and drops the cover chip without a handler', () => {
    const { rerender } = renderWithI18n(
      <GhostAffordanceRow {...defaultProps} onAddCover={vi.fn()} />
    )

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Add cover',
      'Add tag',
      'Add property'
    ])

    rerender(
      <I18nextProvider i18n={i18nEn}>
        <GhostAffordanceRow {...defaultProps} />
      </I18nextProvider>
    )
    expect(screen.queryByTestId('ghost-add-cover')).not.toBeInTheDocument()
  })

  it('fires the cover handler and carries no border', async () => {
    const user = userEvent.setup()
    const onAddCover = vi.fn()
    renderWithI18n(<GhostAffordanceRow {...defaultProps} onAddCover={onAddCover} />)

    const chip = screen.getByTestId('ghost-add-cover')
    expect(chip.className).not.toMatch(/\bborder\b|border-dashed/)
    await user.click(chip)
    expect(onAddCover).toHaveBeenCalledTimes(1)
  })

  it('keeps every chip disabled when the row is disabled', () => {
    renderWithI18n(<GhostAffordanceRow {...defaultProps} onAddCover={vi.fn()} disabled />)

    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  })
})

describe('GhostAffordanceRow - project type guard', () => {
  it('disables the project entry when the note already has one', async () => {
    const user = userEvent.setup()
    renderWithI18n(<GhostAffordanceRow {...defaultProps} existingNames={['project']} />)

    await user.click(screen.getByRole('button', { name: /add property/i }))

    expect(screen.getByRole('option', { name: /^project$/i })).toBeDisabled()
  })
})
