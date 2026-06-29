import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const driveSpy = vi.fn()
let capturedConfig: { onDestroyed?: () => void } | undefined

vi.mock('driver.js', () => ({
  driver: (config: { onDestroyed?: () => void }) => {
    capturedConfig = config
    return { drive: driveSpy }
  }
}))
vi.mock('driver.js/dist/driver.css', () => ({}))
vi.mock('../onboarding/tour.css', () => ({}))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { useFirstRunTour, TOUR_KEY } from './use-first-run-tour'

describe('useFirstRunTour', () => {
  beforeEach(() => {
    localStorage.clear()
    driveSpy.mockClear()
    capturedConfig = undefined
    // jsdom lacks matchMedia
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })
    )
  })

  it('starts the tour when the flag is unset', () => {
    renderHook(() => useFirstRunTour())
    expect(driveSpy).toHaveBeenCalledTimes(1)
  })

  it('sets the flag when the tour is destroyed (finish or skip)', () => {
    renderHook(() => useFirstRunTour())
    expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    capturedConfig?.onDestroyed?.()
    expect(localStorage.getItem(TOUR_KEY)).toBe('1')
  })

  it('does not start the tour when the flag is already set', () => {
    localStorage.setItem(TOUR_KEY, '1')
    renderHook(() => useFirstRunTour())
    expect(driveSpy).not.toHaveBeenCalled()
  })
})
