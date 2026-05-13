import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AISettingsProvider, useAISettingsContext } from './ai-settings-context'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

function Probe(): React.JSX.Element {
  const settings = useAISettingsContext()

  return (
    <div>
      <span data-testid="enabled">{String(settings.enabled)}</span>
      <span data-testid="loading">{String(settings.isLoading)}</span>
      <button type="button" onClick={() => void settings.reload()}>
        reload
      </button>
    </div>
  )
}

describe('AISettingsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const api = window.api as typeof window.api & {
      onSettingsChanged?: (callback: (event: { key: string; value: unknown }) => void) => () => void
    }
    api.settings.getAISettings = vi.fn().mockResolvedValue({ enabled: true })
    api.onSettingsChanged = vi.fn(() => vi.fn())
  })

  it('uses enabled fallback settings outside the provider', async () => {
    const user = userEvent.setup()

    render(<Probe />)

    expect(screen.getByTestId('enabled')).toHaveTextContent('true')
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
    await user.click(screen.getByText('reload'))
  })

  it('loads AI settings and follows settings change events', async () => {
    let onSettingsChanged: ((event: { key: string; value: unknown }) => void) | undefined
    const api = window.api as typeof window.api & {
      onSettingsChanged: (callback: (event: { key: string; value: unknown }) => void) => () => void
    }
    vi.mocked(api.settings.getAISettings).mockResolvedValue({ enabled: true })
    api.onSettingsChanged = vi.fn((callback) => {
      onSettingsChanged = callback
      return vi.fn()
    })

    render(
      <AISettingsProvider>
        <Probe />
      </AISettingsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('enabled')).toHaveTextContent('true')

    act(() => {
      onSettingsChanged?.({ key: 'theme', value: { enabled: false } })
    })
    expect(screen.getByTestId('enabled')).toHaveTextContent('true')

    act(() => {
      onSettingsChanged?.({ key: 'ai', value: { enabled: false } })
    })
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('false'))
  })

  it('falls back safely when settings loading fails and reload recovers', async () => {
    const user = userEvent.setup()
    const api = window.api as typeof window.api
    vi.mocked(api.settings.getAISettings)
      .mockRejectedValueOnce(new Error('settings failed'))
      .mockResolvedValueOnce({ enabled: true })

    render(
      <AISettingsProvider>
        <Probe />
      </AISettingsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('enabled')).toHaveTextContent('false')

    await user.click(screen.getByText('reload'))
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'))
  })

  it('enables AI when the settings API is unavailable', async () => {
    const user = userEvent.setup()
    const api = window.api as typeof window.api & {
      settings: typeof window.api.settings & {
        getAISettings?: typeof window.api.settings.getAISettings
      }
    }
    api.settings.getAISettings = undefined

    render(
      <AISettingsProvider>
        <Probe />
      </AISettingsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('enabled')).toHaveTextContent('true')

    await user.click(screen.getByText('reload'))
    expect(screen.getByTestId('enabled')).toHaveTextContent('true')
  })

  it('disables AI when a manual reload fails', async () => {
    const user = userEvent.setup()
    const api = window.api as typeof window.api
    vi.mocked(api.settings.getAISettings)
      .mockResolvedValueOnce({ enabled: true })
      .mockRejectedValueOnce(new Error('reload failed'))

    render(
      <AISettingsProvider>
        <Probe />
      </AISettingsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'))

    await user.click(screen.getByText('reload'))
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('false'))
  })

  it('loads without a settings change listener', async () => {
    const api = window.api as typeof window.api & {
      onSettingsChanged?: (callback: (event: { key: string; value: unknown }) => void) => () => void
    }
    api.onSettingsChanged = undefined

    render(
      <AISettingsProvider>
        <Probe />
      </AISettingsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'))
  })
})
