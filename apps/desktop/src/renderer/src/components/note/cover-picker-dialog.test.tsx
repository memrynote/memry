/**
 * The cover picker's tab row is the seam a new cover source plugs into, so the
 * tests pin what switching tabs does to the body and to the selection, not just
 * that a tab is highlighted.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import type { UnsplashPhoto } from '@memry/contracts/unsplash-api'
import { coverWashGradient } from '@memry/shared/cover-image'

const listVaultAttachments = vi.hoisted(() => vi.fn())
const insertExistingAttachment = vi.hoisted(() => vi.fn())
const uploadAttachment = vi.hoisted(() => vi.fn())
const unsplashSearch = vi.hoisted(() => vi.fn())
const unsplashDownload = vi.hoisted(() => vi.fn())

vi.mock('@/services/notes-service', () => ({
  notesService: { listVaultAttachments, insertExistingAttachment, uploadAttachment }
}))

vi.mock('@/services/unsplash-service', () => ({
  unsplashService: { search: unsplashSearch, download: unsplashDownload }
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

const UNSPLASH_PHOTO: UnsplashPhoto = {
  id: 'ph_1',
  thumbUrl: 'https://images.unsplash.com/photo-1?w=200',
  previewUrl: 'https://images.unsplash.com/photo-1?w=400',
  fullUrl: 'https://images.unsplash.com/photo-1?w=1080',
  downloadLocation: 'https://api.unsplash.com/photos/ph_1/download',
  authorName: 'Ada Lovelace',
  htmlUrl: 'https://unsplash.com/photos/ph_1',
  blurHash: null,
  width: 4000,
  height: 3000
}

const panel = () => screen.getByTestId('cover-picker-panel')

const PHOTO_SEARCH_DEBOUNCE_MS = 400

/**
 * The empty-query probe the dialog fires on open is free and sends nothing, so
 * the tests count real searches separately from it.
 */
const realSearches = () =>
  unsplashSearch.mock.calls.filter((call) => (call[0] as { query: string }).query !== '')

/** Types into the palette's one search input and lets the debounce elapse. */
async function searchFor(text: string) {
  fireEvent.change(screen.getByTestId('cover-picker-search'), { target: { value: text } })
  await act(async () => {
    vi.advanceTimersByTime(PHOTO_SEARCH_DEBOUNCE_MS)
  })
}

async function openPhotosTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Photos' }))
}

function photosUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

beforeEach(() => {
  listVaultAttachments.mockReset().mockResolvedValue([PHOTO, NOT_AN_IMAGE])
  insertExistingAttachment
    .mockReset()
    .mockResolvedValue({ url: '../attachments/nte_other/beach.png' })
  uploadAttachment.mockReset()
  unsplashSearch
    .mockReset()
    .mockImplementation(({ query }: { query: string }) =>
      Promise.resolve(
        query
          ? { ok: true, photos: [UNSPLASH_PHOTO], rateLimitRemaining: 42 }
          : { ok: true, photos: [], rateLimitRemaining: null }
      )
    )
  unsplashDownload.mockReset().mockResolvedValue({
    ok: true,
    ref: '../attachments/nte_9f2c1a/ph_1.jpg',
    credit: { name: 'Ada Lovelace', url: 'https://unsplash.com/photos/ph_1' }
  })
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
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false'
    ])
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

describe('CoverPickerDialog photos', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on washes and probes availability with a query that sends nothing', async () => {
    renderPicker()

    expect(panel()).toHaveAttribute('data-tab', 'washes')
    await waitFor(() => expect(unsplashSearch).toHaveBeenCalledWith({ query: '' }))
    expect(screen.getByRole('tab', { name: 'Photos' })).toBeInTheDocument()
    expect(realSearches()).toHaveLength(0)
  })

  it('keeps a local filter local, searching nothing while washes is the open tab', async () => {
    renderPicker()

    await searchFor('sage')
    await searchFor('sand')

    expect(realSearches()).toHaveLength(0)
    expect(screen.getAllByTestId('cover-picker-wash')).toHaveLength(1)
  })

  it('hides the photos tab for a build with no access key, before it can be reached', async () => {
    unsplashSearch.mockResolvedValue({ ok: false, reason: 'not-configured' })
    renderPicker()

    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Photos' })).toBeNull())
    expect(screen.getAllByRole('tab')).toHaveLength(COVER_PICKER_TABS.length - 1)
  })

  it('falls back off photos when a late probe says the tab does not exist', async () => {
    let answerProbe: (result: { ok: false; reason: 'not-configured' }) => void = () => {}
    unsplashSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerProbe = resolve
        })
    )
    const user = photosUser()
    renderPicker()

    await openPhotosTab(user)
    expect(panel()).toHaveAttribute('data-tab', 'photos')

    await act(async () => {
      answerProbe({ ok: false, reason: 'not-configured' })
    })

    expect(panel()).toHaveAttribute('data-tab', 'washes')
    expect(screen.queryByRole('tab', { name: 'Photos' })).toBeNull()
  })

  it('searches once per settled query and serves a repeat from the cache', async () => {
    const user = photosUser()
    renderPicker()
    await openPhotosTab(user)

    fireEvent.change(screen.getByTestId('cover-picker-search'), { target: { value: 's' } })
    fireEvent.change(screen.getByTestId('cover-picker-search'), { target: { value: 'su' } })
    await searchFor('sunset')

    await waitFor(() => expect(realSearches()).toHaveLength(1))
    expect(unsplashSearch).toHaveBeenCalledWith({ query: 'sunset', page: 1 })

    await searchFor('')
    await searchFor('sunset')
    expect(realSearches()).toHaveLength(1)
  })

  it('hotlinks the thumbnail and counts the remaining rate limit', async () => {
    const user = photosUser()
    renderPicker()
    await openPhotosTab(user)
    await searchFor('sunset')

    const tile = await screen.findByTestId('cover-picker-photo')
    expect(tile.querySelector('img')).toHaveAttribute('src', UNSPLASH_PHOTO.thumbUrl)
    expect(screen.getByTestId('cover-picker-rate-limit')).toHaveTextContent('42')
  })

  it('marks a spent rate limit without hiding the tab', async () => {
    unsplashSearch.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve(
        query
          ? { ok: true, photos: [UNSPLASH_PHOTO], rateLimitRemaining: 0 }
          : { ok: true, photos: [], rateLimitRemaining: null }
      )
    )
    const user = photosUser()
    renderPicker()
    await openPhotosTab(user)
    await searchFor('sunset')

    const counter = await screen.findByTestId('cover-picker-rate-limit')
    expect(counter.className).toContain('amber')
    expect(screen.getByRole('tab', { name: 'Photos' })).toBeInTheDocument()
  })

  it('downloads the picked photo and applies its ref and credit', async () => {
    const user = photosUser()
    const { onApply, onOpenChange } = renderPicker()
    await openPhotosTab(user)
    await searchFor('sunset')

    await user.click(await screen.findByTestId('cover-picker-photo'))

    await waitFor(() =>
      expect(unsplashDownload).toHaveBeenCalledWith({ noteId: NOTE_ID, photo: UNSPLASH_PHOTO })
    )
    expect(onApply).toHaveBeenCalledWith(
      { kind: 'image', ref: '../attachments/nte_9f2c1a/ph_1.jpg' },
      {
        reposition: false,
        credit: { name: 'Ada Lovelace', url: 'https://unsplash.com/photos/ph_1' }
      }
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open and names the reason when a download fails', async () => {
    const user = photosUser()
    unsplashDownload.mockResolvedValue({ ok: false, reason: 'write-failed' })
    const { onApply, onOpenChange } = renderPicker()
    await openPhotosTab(user)
    await searchFor('sunset')

    await user.click(await screen.findByTestId('cover-picker-photo'))

    const message = await screen.findByTestId('cover-picker-photos-error')
    expect(message).toHaveAttribute('data-reason', 'write-failed')
    expect(message).not.toBeEmptyDOMElement()
    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('gives every failure reason its own line rather than one spinner', async () => {
    const user = photosUser()
    const seen = new Map<string, string>()

    for (const reason of ['offline', 'rate-limited', 'failed'] as const) {
      unsplashSearch.mockImplementation(({ query }: { query: string }) =>
        Promise.resolve(
          query ? { ok: false, reason } : { ok: true, photos: [], rateLimitRemaining: null }
        )
      )
      const { unmount } = render(
        <CoverPickerDialog open onOpenChange={vi.fn()} noteId={NOTE_ID} onApply={vi.fn()} />
      )
      await openPhotosTab(user)
      await searchFor('sunset')

      const message = await screen.findByTestId('cover-picker-photos-error')
      expect(message).toHaveAttribute('data-reason', reason)
      expect(screen.queryByTestId('cover-picker-photos-searching')).toBeNull()
      seen.set(reason, message.textContent ?? '')
      unmount()
    }

    expect(new Set(seen.values()).size).toBe(3)
  })
})
