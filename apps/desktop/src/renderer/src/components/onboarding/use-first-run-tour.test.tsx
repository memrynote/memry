import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GENERAL_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'

const driveSpy = vi.fn()
const destroySpy = vi.fn()
type TourStep = {
  element?: string
  onHighlightStarted?: () => void
  onDeselected?: () => void
}
type TourConfig = { onDestroyed?: () => void; steps?: TourStep[] }
let capturedConfig: TourConfig | undefined

vi.mock('driver.js', () => ({
  driver: (config: TourConfig) => {
    capturedConfig = config
    // Mirror driver.js: destroy() runs the onDestroyed hook.
    return {
      drive: driveSpy,
      destroy: () => {
        destroySpy()
        config.onDestroyed?.()
      }
    }
  }
}))
vi.mock('driver.js/dist/driver.css', () => ({}))
vi.mock('../onboarding/tour.css', () => ({}))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/contexts/day-panel-context', () => ({ useDayPanel: () => ({ open: vi.fn() }) }))

import { useFirstRunTour, TOUR_KEY } from './use-first-run-tour'
import { STAR_PROMPT_EVENT, STAR_PROMPT_KEY } from './star-prompt'

/**
 * What the open vault has on disk. Unlike renderer localStorage, this is what an
 * update carries over: the vault's data DB (general settings) and its notes.
 */
let vault: { onboardingCompleted: boolean; noteTotal: number }

/** Let the hook's settings/notes reads resolve. */
const settle = async (): Promise<void> => {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

describe('useFirstRunTour', () => {
  beforeEach(() => {
    localStorage.clear()
    vault = { onboardingCompleted: false, noteTotal: 0 }
    window.api.settings.getGeneralSettings = vi.fn(async () => ({
      ...GENERAL_SETTINGS_DEFAULTS,
      onboardingCompleted: vault.onboardingCompleted
    }))
    window.api.settings.setGeneralSettings = vi.fn(async (updates) => {
      if (updates.onboardingCompleted !== undefined) {
        vault.onboardingCompleted = updates.onboardingCompleted
      }
      return { success: true }
    })
    window.api.notes.list = vi.fn(async () => ({
      notes: [],
      total: vault.noteTotal,
      hasMore: vault.noteTotal > 0
    }))
    driveSpy.mockClear()
    destroySpy.mockClear()
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
    // run the deferred drive synchronously
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
  })

  it('starts the tour when the flag is unset', async () => {
    renderHook(() => useFirstRunTour())
    await settle()
    expect(driveSpy).toHaveBeenCalledTimes(1)
  })

  it('sets the flag when the tour is destroyed (finish or skip)', async () => {
    renderHook(() => useFirstRunTour())
    await settle()
    expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    capturedConfig?.onDestroyed?.()
    expect(localStorage.getItem(TOUR_KEY)).toBe('1')
  })

  it('arms the star prompt when the tour is destroyed, and announces it', async () => {
    const announced = vi.fn()
    window.addEventListener(STAR_PROMPT_EVENT, announced)

    renderHook(() => useFirstRunTour())
    await settle()
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBeNull()

    capturedConfig?.onDestroyed?.()
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('pending')
    expect(announced).toHaveBeenCalledTimes(1)

    window.removeEventListener(STAR_PROMPT_EVENT, announced)
  })

  it('never re-arms the star prompt for a user who already answered it', async () => {
    const announced = vi.fn()
    window.addEventListener(STAR_PROMPT_EVENT, announced)
    localStorage.setItem(STAR_PROMPT_KEY, 'done')

    renderHook(() => useFirstRunTour())
    await settle()
    capturedConfig?.onDestroyed?.()

    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('done')
    expect(announced).not.toHaveBeenCalled()

    window.removeEventListener(STAR_PROMPT_EVENT, announced)
  })

  it('does not start the tour when the flag is already set', async () => {
    localStorage.setItem(TOUR_KEY, '1')
    renderHook(() => useFirstRunTour())
    await settle()
    expect(driveSpy).not.toHaveBeenCalled()
  })

  it('keeps only the welcome step and steps whose target is mounted', async () => {
    document.body.innerHTML = '<button data-tour="new-note">new</button>'
    renderHook(() => useFirstRunTour())
    await settle()

    const steps = capturedConfig?.steps ?? []
    // welcome step has no element; new-note is mounted; everything else is absent
    expect(steps.some((s) => s.element === undefined)).toBe(true)
    expect(steps.some((s) => s.element === '[data-tour="new-note"]')).toBe(true)
    expect(steps.some((s) => s.element === '[data-tour="nav-inbox"]')).toBe(false)
    expect(steps).toHaveLength(2)

    document.body.innerHTML = ''
  })

  it('drives the right-sidebar tabs: agent step opens Agent, restores Day on exit', async () => {
    const dayClick = vi.fn()
    const agentClick = vi.fn()
    document.body.innerHTML =
      '<button data-tour="rsb-day"></button>' +
      '<button data-tour="rsb-agent"></button>' +
      '<div data-slot="day-panel-inner"></div>'
    document.querySelector('[data-tour="rsb-day"]')?.addEventListener('click', dayClick)
    document.querySelector('[data-tour="rsb-agent"]')?.addEventListener('click', agentClick)

    renderHook(() => useFirstRunTour())
    await settle()

    const agentStep = capturedConfig?.steps?.find((s) => s.element === '[data-tour="rsb-agent"]')
    expect(agentStep).toBeDefined()

    agentStep?.onHighlightStarted?.()
    expect(agentClick).toHaveBeenCalledTimes(1)

    agentStep?.onDeselected?.()
    expect(dayClick).toHaveBeenCalledTimes(1)

    document.body.innerHTML = ''
  })

  describe('after an app update empties renderer localStorage', () => {
    it('skips the tour for an existing user whose vault already has notes', async () => {
      vault.noteTotal = 42

      renderHook(() => useFirstRunTour())
      await settle()

      expect(driveSpy).not.toHaveBeenCalled()
      expect(vault.onboardingCompleted).toBe(true)
      expect(localStorage.getItem(TOUR_KEY)).toBe('1')
    })

    it('skips the tour when the vault settings record onboarding as completed', async () => {
      vault.onboardingCompleted = true

      renderHook(() => useFirstRunTour())
      await settle()

      expect(driveSpy).not.toHaveBeenCalled()
    })

    it('never shows the tour again once finished, even after localStorage is lost', async () => {
      const firstLaunch = renderHook(() => useFirstRunTour())
      await settle()
      expect(driveSpy).toHaveBeenCalledTimes(1)
      capturedConfig?.onDestroyed?.()
      await settle()
      firstLaunch.unmount()

      localStorage.clear()
      renderHook(() => useFirstRunTour())
      await settle()

      expect(driveSpy).toHaveBeenCalledTimes(1)
      expect(vault.onboardingCompleted).toBe(true)
    })

    it('carries a pre-fix localStorage flag into the vault settings', async () => {
      localStorage.setItem(TOUR_KEY, '1')

      renderHook(() => useFirstRunTour())
      await settle()

      expect(driveSpy).not.toHaveBeenCalled()
      expect(vault.onboardingCompleted).toBe(true)
    })

    it('holds the tour back when the onboarding record cannot be read', async () => {
      window.api.settings.getGeneralSettings = vi.fn(async () => {
        throw new Error('no vault open')
      })

      renderHook(() => useFirstRunTour())
      await settle()

      expect(driveSpy).not.toHaveBeenCalled()
      expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    })
  })

  describe('cleanup', () => {
    /**
     * Real rAF semantics: a queued callback runs on the next frame unless it is
     * cancelled first. `flush()` runs only the frames that survived.
     */
    const deferFrames = (): (() => void) => {
      const pending = new Map<number, FrameRequestCallback>()
      let nextHandle = 0
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        nextHandle += 1
        pending.set(nextHandle, cb)
        return nextHandle
      })
      vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        pending.delete(handle)
      })
      return () => {
        const frames = [...pending.values()]
        pending.clear()
        frames.forEach((cb) => cb(0))
      }
    }

    it('cancels the queued frame when unmounted before the tour starts', async () => {
      const flush = deferFrames()

      const { unmount } = renderHook(() => useFirstRunTour())
      await settle()
      unmount()
      flush()

      expect(driveSpy).not.toHaveBeenCalled()
    })

    it('never starts the tour when unmounted before the onboarding record is read', async () => {
      const { unmount } = renderHook(() => useFirstRunTour())
      unmount()
      await settle()

      expect(driveSpy).not.toHaveBeenCalled()
    })

    it('destroys the driver instance when unmounted while the tour is running', async () => {
      const { unmount } = renderHook(() => useFirstRunTour())
      await settle()
      expect(driveSpy).toHaveBeenCalledTimes(1)

      unmount()

      expect(destroySpy).toHaveBeenCalledTimes(1)
    })

    it('does not record the tour as seen when unmount is what tore it down', async () => {
      const announced = vi.fn()
      window.addEventListener(STAR_PROMPT_EVENT, announced)

      const { unmount } = renderHook(() => useFirstRunTour())
      await settle()
      unmount()

      expect(localStorage.getItem(TOUR_KEY)).toBeNull()
      expect(vault.onboardingCompleted).toBe(false)
      expect(localStorage.getItem(STAR_PROMPT_KEY)).toBeNull()
      expect(announced).not.toHaveBeenCalled()

      window.removeEventListener(STAR_PROMPT_EVENT, announced)
    })

    it('still starts exactly one tour when effects are double-invoked', async () => {
      const flush = deferFrames()

      renderHook(() => useFirstRunTour(), { wrapper: StrictMode })
      await settle()
      flush()

      expect(driveSpy).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    })
  })
})
