/**
 * The cover picker's tab row is the seam a new cover source plugs into, so the
 * tests pin what switching tabs does to the body and to the selection, not just
 * that a tab is highlighted.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import { coverWashGradient } from '@memry/shared/cover-image'

const listVaultAttachments = vi.hoisted(() => vi.fn())
const insertExistingAttachment = vi.hoisted(() => vi.fn())
const uploadAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/services/notes-service', () => ({
  notesService: { listVaultAttachments, insertExistingAttachment, uploadAttachment }
}))

import { COVER_PICKER_TABS, CoverPickerDialog } from './cover-picker-dialog'

const NOTE_ID = 'nte_9f2c1a'

const PHOTO: VaultAttachmentEntry = {
  ownerNoteId: 'nte_other',
  ownerNoteTitle: 'Trips',
  filename: 'beach.png',
  displayName: 'beach.png',
  mimeType: 'image/png',
  size: 2048,
  type: 'image'
} as VaultAttachmentEntry

const NOT_AN_IMAGE: VaultAttachmentEntry = {
  ...PHOTO,
  filename: 'notes.pdf',
  displayName: 'notes.pdf',
  mimeType: 'application/pdf',
  type: 'file'
} as VaultAttachmentEntry

function renderPicker() {
  const onApply = vi.fn()
  const onOpenChange = vi.fn()
  render(<CoverPickerDialog open onOpenChange={onOpenChange} noteId={NOTE_ID} onApply={onApply} />)
  return { onApply, onOpenChange }
}

const panel = () => screen.getByTestId('cover-picker-panel')

beforeEach(() => {
  listVaultAttachments.mockReset().mockResolvedValue([PHOTO, NOT_AN_IMAGE])
  insertExistingAttachment
    .mockReset()
    .mockResolvedValue({ url: '../attachments/nte_other/beach.png' })
  uploadAttachment.mockReset()
})

describe('CoverPickerDialog tabs', () => {
  it('opens on washes with all twelve plus an upload tile', async () => {
    renderPicker()

    expect(panel()).toHaveAttribute('data-tab', 'washes')
    expect(screen.getAllByTestId('cover-picker-wash')).toHaveLength(12)
    expect(screen.getByTestId('cover-picker-upload')).toBeInTheDocument()
    await waitFor(() => expect(listVaultAttachments).toHaveBeenCalled())
  })

  it('switches to the vault image list and back, showing only images', async () => {
    const user = userEvent.setup()
    renderPicker()
    await waitFor(() => expect(listVaultAttachments).toHaveBeenCalled())

    await user.click(screen.getByRole('tab', { name: 'From note' }))
    expect(panel()).toHaveAttribute('data-tab', 'fromNote')
    expect(screen.queryByTestId('cover-picker-wash')).not.toBeInTheDocument()
    const rows = screen.getAllByTestId('cover-picker-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('beach.png')

    await user.click(screen.getByRole('tab', { name: 'Washes' }))
    expect(panel()).toHaveAttribute('data-tab', 'washes')
    expect(screen.getAllByTestId('cover-picker-wash')).toHaveLength(12)
  })

  it('shows the upload tab as a single row', async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(screen.getByRole('tab', { name: 'Upload' }))
    expect(panel()).toHaveAttribute('data-tab', 'upload')
    expect(screen.getByTestId('cover-picker-upload')).toBeInTheDocument()
    expect(screen.queryByTestId('cover-picker-wash')).not.toBeInTheDocument()
  })

  it('marks exactly one tab selected and resets the selection when it changes', async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getAllByTestId('cover-picker-wash')[2]).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: 'From note' }))
    await user.click(screen.getByRole('tab', { name: 'Washes' }))

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(screen.getAllByTestId('cover-picker-wash')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the rendered tab row in step with the exported table', () => {
    renderPicker()

    expect(screen.getAllByRole('tab')).toHaveLength(COVER_PICKER_TABS.length)
  })
})

describe('CoverPickerDialog apply', () => {
  it('applies a wash without reposition and closes', async () => {
    const user = userEvent.setup()
    const { onApply, onOpenChange } = renderPicker()

    await user.click(screen.getAllByTestId('cover-picker-wash')[0])

    expect(onApply).toHaveBeenCalledWith({ kind: 'wash', id: 'sage' }, { reposition: false })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('steps the wash grid a row at a time with arrow down', async () => {
    const user = userEvent.setup()
    const { onApply } = renderPicker()

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onApply).toHaveBeenCalledWith({ kind: 'wash', id: 'ash' }, { reposition: false })
  })

  it('asks for reposition on cmd-enter over a vault image', async () => {
    const user = userEvent.setup()
    const { onApply } = renderPicker()
    await waitFor(() => expect(listVaultAttachments).toHaveBeenCalled())

    await user.click(screen.getByRole('tab', { name: 'From note' }))
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(
        { kind: 'image', ref: '../attachments/nte_other/beach.png' },
        { reposition: true }
      )
    )
  })

  it('paints each wash tile with its own gradient', () => {
    renderPicker()

    expect(screen.getAllByTestId('cover-picker-wash')[0]).toHaveStyle({
      backgroundImage: coverWashGradient('sage')
    })
  })

  it('reports an empty vault rather than an empty box', async () => {
    const user = userEvent.setup()
    listVaultAttachments.mockResolvedValue([])
    renderPicker()
    await waitFor(() => expect(listVaultAttachments).toHaveBeenCalled())

    await user.click(screen.getByRole('tab', { name: 'From note' }))
    expect(screen.getByTestId('cover-picker-empty')).toBeInTheDocument()
  })
})
