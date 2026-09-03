import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { AppearanceSettings } from './appearance-section'

const mocks = vi.hoisted(() => ({
  generalSettings: {
    settings: {
      theme: 'system',
      accentColor: '#6366f1',
      fontSize: 'medium',
      fontSizePx: 16 as number | undefined,
      fontFamily: 'system',
      customFontFamily: ''
    },
    isLoading: false,
    updateSettings: vi.fn()
  }
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => mocks.generalSettings
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const FONT_SIZE_ARIA = 'Font size'

// The page carries a second slider (zoom), so every lookup is scoped by name.
const fontSizeSlider = (): HTMLElement => screen.getByRole('slider', { name: FONT_SIZE_ARIA })

// Radix's pointer path lives on the Root, which is the only one of the two
// elements carrying `dir`. Pressing the Thumb — the element that owns
// role="slider" and the accessible name — is read as grabbing the existing
// thumb and moves nothing.
const sliderTrack = (): HTMLElement => fontSizeSlider().closest('[dir]') as HTMLElement

beforeAll(() => {
  // Radix's slider drives its pointer path through capture APIs jsdom omits.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => true)
})

describe('Appearance font size slider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generalSettings.settings = {
      theme: 'system',
      accentColor: '#6366f1',
      fontSize: 'medium',
      fontSizePx: 16,
      fontFamily: 'system',
      customFontFamily: ''
    }
    mocks.generalSettings.updateSettings.mockResolvedValue(true)
    document.documentElement.removeAttribute('style')
  })

  it('#given a screen reader #then the name is on the element that carries role="slider"', () => {
    render(<AppearanceSettings />)

    // Radix names the Thumb, not the Root, so an aria-label the Root swallows
    // leaves the control anonymous however it looks in the markup.
    expect(screen.getByRole('slider', { name: FONT_SIZE_ARIA })).toBeInTheDocument()
  })

  it('#given a drag in progress #then the interface resizes live without saving', () => {
    render(<AppearanceSettings />)

    // jsdom measures the track as zero-width, which Radix maps to the minimum.
    fireEvent.pointerDown(sliderTrack(), { clientX: 0, pointerId: 1 })

    expect(document.documentElement.style.fontSize).toBe('12px')
    expect(fontSizeSlider()).toHaveAttribute('aria-valuenow', '12')
    expect(mocks.generalSettings.updateSettings).not.toHaveBeenCalled()
  })

  it('#given the drag is released #then both the pixel size and the legacy bucket are saved', async () => {
    render(<AppearanceSettings />)

    const track = sliderTrack()
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 })

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 12,
        fontSize: 'small'
      })
    )
  })

  it('#given an arrow key on the slider #then the step is saved without a pointer release', async () => {
    render(<AppearanceSettings />)

    fireEvent.keyDown(fontSizeSlider(), { key: 'ArrowRight' })

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 17,
        fontSize: 'medium'
      })
    )
    expect(document.documentElement.style.fontSize).toBe('17px')
  })

  it('#given the reset button #then the size returns to the default', async () => {
    // Both fields, because that is how every save writes them. A 22 sitting
    // next to 'medium' is a pair no build produces, and resolveFontSizePx reads
    // it as an older device having moved the bucket on its own.
    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSizePx: 22,
      fontSize: 'large'
    }
    render(<AppearanceSettings />)

    fireEvent.click(screen.getByLabelText('Reset font size to default'))

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 16,
        fontSize: 'medium'
      })
    )
    expect(document.documentElement.style.fontSize).toBe('16px')
  })

  it('#given the save fails #then the previewed size is rolled back and the failure is reported', async () => {
    mocks.generalSettings.updateSettings.mockResolvedValue(false)
    render(<AppearanceSettings />)

    const track = sliderTrack()
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update font size'))
    expect(document.documentElement.style.fontSize).toBe('16px')
  })

  it('#given a drag that wanders and returns to where it started #then nothing is written and the row still follows a later remote change', async () => {
    const { rerender } = render(<AppearanceSettings />)

    const track = sliderTrack()
    // A real width, so the drag can travel and come back. Left at jsdom's zero
    // width every position maps to the minimum and the round trip is impossible.
    track.getBoundingClientRect = () => new DOMRect(0, 0, 120, 8)

    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 })
    expect(fontSizeSlider()).toHaveAttribute('aria-valuenow', '20')

    fireEvent.pointerMove(track, { clientX: 40, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 40, pointerId: 1 })

    // Radix reports no commit here, so the draft has to retire on its own.
    await waitFor(() => expect(mocks.generalSettings.updateSettings).not.toHaveBeenCalled())

    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSizePx: 22,
      fontSize: 'large'
    }
    rerender(<AppearanceSettings />)

    await waitFor(() => expect(fontSizeSlider()).toHaveAttribute('aria-valuenow', '22'))
  })

  it('#given a held arrow key #then the whole run is written once, not once per keydown', async () => {
    render(<AppearanceSettings />)

    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(fontSizeSlider(), { key: 'ArrowRight' })
    }

    expect(fontSizeSlider()).toHaveAttribute('aria-valuenow', '22')

    await waitFor(() => expect(mocks.generalSettings.updateSettings).toHaveBeenCalled())
    expect(mocks.generalSettings.updateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
      fontSizePx: 22,
      fontSize: 'large'
    })
  })

  it('#given settings closed straight after a drag #then the pending size is saved rather than dropped', async () => {
    const { unmount } = render(<AppearanceSettings />)

    fireEvent.pointerDown(sliderTrack(), { clientX: 0, pointerId: 1 })
    expect(document.documentElement.style.fontSize).toBe('12px')

    unmount()

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 12,
        fontSize: 'small'
      })
    )
  })

  it('#given only the legacy bucket is stored #then the slider starts at that pixel size', () => {
    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSize: 'large',
      fontSizePx: undefined
    }
    render(<AppearanceSettings />)

    expect(fontSizeSlider()).toHaveAttribute('aria-valuenow', '20')
  })
})
