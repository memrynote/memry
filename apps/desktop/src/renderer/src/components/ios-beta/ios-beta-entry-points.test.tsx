import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { suppressFirstRunPromptsInE2E } from '../../../../preload/lib/e2e-onboarding'

const mocks = vi.hoisted(() => ({
  join: vi.fn()
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { email: null } })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key
  })
}))

// The store caches its snapshot per module; a fresh import is a fresh app launch.
const launch = async () => {
  vi.resetModules()
  return import('./ios-beta-entry-points')
}

beforeEach(() => {
  localStorage.clear()
  mocks.join.mockReset().mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = { iosBeta: { join: mocks.join } }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('iPhone beta launch prompt', () => {
  it('shows once; after closing it stays closed on the next launch', async () => {
    const first = await launch()
    const { unmount } = render(<first.IosBetaLaunchPrompt />)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    unmount()

    const second = await launch()
    render(<second.IosBetaLaunchPrompt />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // #4428: every E2E launch has a fresh profile, so the prompt's overlay covered the
  // window and intercepted every click in every Electron spec.
  it('never opens on an E2E launch, and still opens without the E2E signal', async () => {
    // what preload runs before the renderer mounts, in a packaged build
    suppressFirstRunPromptsInE2E()
    const packaged = await launch()
    const { unmount } = render(<packaged.IosBetaLaunchPrompt />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    unmount()

    localStorage.clear()
    vi.stubEnv('TEST_VAULT_PATH', '/tmp/e2e-vault')
    suppressFirstRunPromptsInE2E()
    const e2e = await launch()
    render(<e2e.IosBetaLaunchPrompt />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('joins from the prompt, confirms in place, and the Settings entry shows where it went', async () => {
    const first = await launch()
    render(<first.IosBetaLaunchPrompt />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' me@example.com ' } })
    fireEvent.click(screen.getByRole('button', { name: 'iosBeta.submit' }))

    await screen.findByText('iosBeta.sentTitle')
    expect(mocks.join).toHaveBeenCalledWith({ email: 'me@example.com', source: 'launch_prompt' })

    fireEvent.click(screen.getByRole('button', { name: 'iosBeta.done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const second = await launch()
    render(
      <>
        <second.IosBetaLaunchPrompt />
        <second.IosBetaSettingsEntry />
      </>
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('iosBeta.entrySent me@example.com')).toBeTruthy()
  })
})
