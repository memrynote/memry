import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const decreaseButton = (): HTMLElement => screen.getByLabelText('Decrease zoom')
const increaseButton = (): HTMLElement => screen.getByLabelText('Increase zoom')

describe('Appearance zoom stepper', () => {
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

  it('#given the increase button #then the interface grows one stop and the stop is saved', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(increaseButton())

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.1)
    expect(screen.getByText('110%')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.1 })
    )
  })

  it('#given the decrease button #then the interface shrinks one stop and the stop is saved', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(decreaseButton())

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.9)
    expect(screen.getByText('90%')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 0.9 })
    )
  })

  it('#given a burst of clicks #then only the value the user landed on is written', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(increaseButton())
    fireEvent.click(increaseButton())
    fireEvent.click(increaseButton())

    expect(screen.getByText('130%')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.3 })
    )
    expect(mocks.generalSettings.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('#given the smallest zoom #then decrease is disabled and increase is not', () => {
    mocks.generalSettings.settings = { ...mocks.generalSettings.settings, zoomFactor: 0.5 }
    render(<AppearanceSettings />)

    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(decreaseButton()).toBeDisabled()
    expect(increaseButton()).toBeEnabled()
  })

  it('#given the largest zoom #then increase is disabled and decrease is not', () => {
    mocks.generalSettings.settings = { ...mocks.generalSettings.settings, zoomFactor: 2 }
    render(<AppearanceSettings />)

    expect(screen.getByText('200%')).toBeInTheDocument()
    expect(increaseButton()).toBeDisabled()
    expect(decreaseButton()).toBeEnabled()
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

    fireEvent.click(increaseButton())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update zoom level'))
    // useThemeSync never re-runs for a value that never changed, so the row has
    // to hand the previous factor back to the frame itself.
    expect(mocks.setZoomFactor).toHaveBeenLastCalledWith(1)
  })

  it('#given settings closed straight after a click #then the pending factor is saved rather than dropped', async () => {
    const { unmount } = render(<AppearanceSettings />)

    fireEvent.click(decreaseButton())
    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.9)

    unmount()

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ zoomFactor: 0.9 })
    )
  })

  it('#given a stored factor off the zoom grid #then the row shows the nearest stop', () => {
    mocks.generalSettings.settings = { ...mocks.generalSettings.settings, zoomFactor: 0.7000000001 }
    render(<AppearanceSettings />)

    expect(screen.getByText('70%')).toBeInTheDocument()
  })
})
