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
      fontSizePx: 16,
      fontFamily: 'system',
      customFontFamily: '',
      zoomFactor: 1 as number | undefined
    },
    isLoading: false,
    updateSettings: vi.fn()
  },
  setZoomFactor: vi.fn()
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => mocks.generalSettings
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const ZOOM_ARIA = 'Zoom level'

// The page carries a second slider (font size), so every lookup is scoped by name.
const zoomSlider = (): HTMLElement => screen.getByRole('slider', { name: ZOOM_ARIA })

// Radix's pointer path lives on the Root, which is the only one of the two
// elements carrying `dir`. Pressing the Thumb — the element that owns
// role="slider" and the accessible name — is read as grabbing the existing
// thumb and moves nothing.
const sliderTrack = (): HTMLElement => zoomSlider().closest('[dir]') as HTMLElement

beforeAll(() => {
  // Radix's slider drives its pointer path through capture APIs jsdom omits.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => true)
})

describe('Appearance zoom slider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generalSettings.settings = {
      theme: 'system',
      accentColor: '#6366f1',
      fontSize: 'medium',
      fontSizePx: 16,
      fontFamily: 'system',
      customFontFamily: '',
      zoomFactor: 1
    }
    mocks.generalSettings.updateSettings.mockResolvedValue(true)
    window.api = { setZoomFactor: mocks.setZoomFactor } as unknown as typeof window.api
  })

  it('#given a screen reader #then the name is on the element that carries role="slider"', () => {
    render(<AppearanceSettings />)

    expect(zoomSlider()).toBeInTheDocument()
  })

  it('#given a drag in progress #then the interface rescales live without saving', () => {
    render(<AppearanceSettings />)

    // jsdom measures the track as zero-width, which Radix maps to the minimum.
    fireEvent.pointerDown(sliderTrack(), { clientX: 0, pointerId: 1 })

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.5)
    expect(zoomSlider()).toHaveAttribute('aria-valuenow', '0.5')
    expect(mocks.generalSettings.updateSettings).not.toHaveBeenCalled()
  })

  it('#given the drag is released #then the factor is saved once the row settles', async () => {
    render(<AppearanceSettings />)

    const track = sliderTrack()
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 })

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 0.5 })
    )
  })

  it('#given an arrow key on the slider #then one stop is saved without a pointer release', async () => {
    render(<AppearanceSettings />)

    fireEvent.keyDown(zoomSlider(), { key: 'ArrowRight' })

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.1 })
    )
    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.1)
  })

  it('#given the reset button #then the interface returns to 100%', async () => {
    mocks.generalSettings.settings = { ...mocks.generalSettings.settings, zoomFactor: 1.4 }
    render(<AppearanceSettings />)

    expect(screen.getByText('140%')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Reset zoom to default'))

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1)
    expect(screen.getByText('100%')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1 })
    )
  })

  it('#given the save fails #then the previewed zoom is rolled back and the failure is reported', async () => {
    mocks.generalSettings.updateSettings.mockResolvedValue(false)
    render(<AppearanceSettings />)

    const track = sliderTrack()
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update zoom level'))
    // useThemeSync never re-runs for a value that never changed, so the row has
    // to hand the previous factor back to the frame itself.
    expect(mocks.setZoomFactor).toHaveBeenLastCalledWith(1)
  })

  it('#given settings closed straight after a drag #then the pending factor is saved rather than dropped', async () => {
    const { unmount } = render(<AppearanceSettings />)

    fireEvent.pointerDown(sliderTrack(), { clientX: 0, pointerId: 1 })
    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.5)

    unmount()

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 0.5 })
    )
  })

  it('#given a stored factor off the slider grid #then the row shows the nearest stop', () => {
    mocks.generalSettings.settings = { ...mocks.generalSettings.settings, zoomFactor: 0.7000000001 }
    render(<AppearanceSettings />)

    expect(zoomSlider()).toHaveAttribute('aria-valuenow', '0.7')
    expect(screen.getByText('70%')).toBeInTheDocument()
  })
})
