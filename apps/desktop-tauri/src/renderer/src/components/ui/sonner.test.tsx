import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { takeCrashReload } = vi.hoisted(() => ({ takeCrashReload: vi.fn() }))
vi.mock('../../../../generated/bindings', () => ({
  commands: { shellTakeCrashReload: takeCrashReload }
}))

import { Toaster } from './sonner'

const NOTICE = 'MemryNote reloaded after a crash. Recent edits may be lost.'

describe('Toaster', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  // The page that asks is the one the shell reloaded, and it may mount its toaster only after a
  // loading screen without one.
  it('tells the user when the shell reloaded this page after its web process died', async () => {
    takeCrashReload.mockResolvedValue(true)
    render(<Toaster />)
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    // It stays until dismissed: the crash may have happened while the user looked elsewhere.
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
    expect(screen.queryByText(NOTICE)).not.toBeNull()
  })

  it('says nothing after a normal load', async () => {
    takeCrashReload.mockResolvedValue(false)
    render(<Toaster />)
    await vi.waitFor(() => expect(takeCrashReload).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(NOTICE)).toBeNull()
  })
})
