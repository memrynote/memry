import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  join: vi.fn()
}))

vi.mock('../../../../generated/bindings', () => ({
  commands: { iosBetaJoin: mocks.join }
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
  mocks.join.mockReset().mockResolvedValue({ success: true, error: null })
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
