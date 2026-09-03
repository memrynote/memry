import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const decreaseButton = (): HTMLElement => screen.getByLabelText('Decrease font size')
const increaseButton = (): HTMLElement => screen.getByLabelText('Increase font size')
const resetButton = (): HTMLElement => screen.getByLabelText('Reset font size to default')

describe('Appearance font size stepper', () => {
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

  it('#given a screen reader #then every control in the row has a name', () => {
    render(<AppearanceSettings />)

    expect(decreaseButton()).toBeInTheDocument()
    expect(increaseButton()).toBeInTheDocument()
    expect(resetButton()).toBeInTheDocument()
  })

  it('#given a step #then the interface resizes live before anything is written', () => {
    render(<AppearanceSettings />)

    fireEvent.click(increaseButton())

    expect(document.documentElement.style.fontSize).toBe('17px')
    expect(screen.getByText('17')).toBeInTheDocument()
    expect(mocks.generalSettings.updateSettings).not.toHaveBeenCalled()
  })

  it('#given the increase button #then both the pixel size and the legacy bucket are saved', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(increaseButton())

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 17,
        fontSize: 'medium'
      })
    )
  })

  it('#given the decrease button #then the interface shrinks one pixel and the step is saved', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(decreaseButton())

    expect(document.documentElement.style.fontSize).toBe('15px')
    expect(screen.getByText('15')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 15,
        fontSize: 'small'
      })
    )
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

    expect(screen.getByText('22')).toBeInTheDocument()

    fireEvent.click(resetButton())

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

    fireEvent.click(increaseButton())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update font size'))
    // The settings hook never re-runs for a value that never changed, so the
    // row has to hand the previous size back to the root element itself.
    expect(document.documentElement.style.fontSize).toBe('16px')
  })

  it('#given a step out and back to the saved size #then nothing is written and the row still follows a later remote change', async () => {
    const { rerender } = render(<AppearanceSettings />)

    fireEvent.click(increaseButton())
    expect(screen.getByText('17')).toBeInTheDocument()
    fireEvent.click(decreaseButton())
    expect(screen.getByText('16')).toBeInTheDocument()

    // Past the commit delay, so the pending write has run and declined rather
    // than merely being still queued.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(mocks.generalSettings.updateSettings).not.toHaveBeenCalled()

    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSizePx: 22,
      fontSize: 'large'
    }
    rerender(<AppearanceSettings />)

    expect(screen.getByText('22')).toBeInTheDocument()
  })

  it('#given a burst of clicks #then only the size the user landed on is written', async () => {
    render(<AppearanceSettings />)

    fireEvent.click(increaseButton())
    fireEvent.click(increaseButton())
    fireEvent.click(increaseButton())

    expect(screen.getByText('19')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 19,
        fontSize: 'large'
      })
    )
    expect(mocks.generalSettings.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('#given settings closed straight after a click #then the pending size is saved rather than dropped', async () => {
    const { unmount } = render(<AppearanceSettings />)

    fireEvent.click(decreaseButton())
    expect(document.documentElement.style.fontSize).toBe('15px')

    unmount()

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 15,
        fontSize: 'small'
      })
    )
  })

  it('#given only the legacy bucket is stored #then the row starts at that pixel size', () => {
    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSize: 'large',
      fontSizePx: undefined
    }
    render(<AppearanceSettings />)

    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('#given the smallest size #then decrease is disabled and increase is not', () => {
    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSizePx: 12,
      fontSize: 'small'
    }
    render(<AppearanceSettings />)

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(decreaseButton()).toBeDisabled()
    expect(increaseButton()).toBeEnabled()
  })

  it('#given the largest size #then increase is disabled and decrease is not', () => {
    mocks.generalSettings.settings = {
      ...mocks.generalSettings.settings,
      fontSizePx: 24,
      fontSize: 'large'
    }
    render(<AppearanceSettings />)

    expect(screen.getByText('24')).toBeInTheDocument()
    expect(increaseButton()).toBeDisabled()
    expect(decreaseButton()).toBeEnabled()
  })
})
