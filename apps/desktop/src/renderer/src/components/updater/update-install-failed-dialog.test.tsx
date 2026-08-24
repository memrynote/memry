import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

const mocks = vi.hoisted(() => ({
  state: {} as AppUpdateState
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({ state: mocks.state })
}))

import {
  UpdateInstallFailedDialog,
  shouldShowInstallFailedPrompt
} from './update-install-failed-dialog'

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'idle',
    updateSupported: true,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    releaseNotesHtml: null,
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoCheckEnabled: true,
    installFailed: null,
    ...overrides
  }
}

describe('shouldShowInstallFailedPrompt', () => {
  it('surfaces a failed install', () => {
    expect(
      shouldShowInstallFailedPrompt(state({ installFailed: { version: 'v1.2.7' } }), false)
    ).toBe(true)
  })

  it('surfaces a failure whose target version was never recorded', () => {
    // The failure is what matters — losing the version must not hide it.
    expect(shouldShowInstallFailedPrompt(state({ installFailed: { version: null } }), false)).toBe(
      true
    )
  })

  it('stays silent on a normal launch', () => {
    expect(shouldShowInstallFailedPrompt(state(), false)).toBe(false)
  })

  it('stays silent once dismissed', () => {
    expect(
      shouldShowInstallFailedPrompt(state({ installFailed: { version: 'v1.2.7' } }), true)
    ).toBe(false)
  })

  it('stays silent where updates are not supported (dev builds)', () => {
    expect(
      shouldShowInstallFailedPrompt(
        state({ installFailed: { version: 'v1.2.7' }, updateSupported: false }),
        false
      )
    ).toBe(false)
  })
})

describe('UpdateInstallFailedDialog', () => {
  beforeEach(() => {
    mocks.state = state()
  })

  it('renders nothing on a normal launch', () => {
    const { container } = render(<UpdateInstallFailedDialog />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names both versions so the user can see they did not move', () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })

    render(<UpdateInstallFailedDialog />)

    expect(screen.getByText(/v1\.2\.7/)).toBeInTheDocument()
    expect(screen.getByText(/2026\.700\.1/)).toBeInTheDocument()
  })

  it('still explains the failure when the target version is unknown', () => {
    mocks.state = state({ installFailed: { version: null } })

    render(<UpdateInstallFailedDialog />)

    // Falls back to the version-less copy rather than rendering a raw
    // placeholder or hiding the failure entirely.
    expect(screen.getByText(/tried to install an update/)).toBeInTheDocument()
  })

  it('hands the user the manual installer and closes', async () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)

    render(<UpdateInstallFailedDialog />)
    await userEvent.click(screen.getByRole('button', { name: /download installer/i }))

    expect(open).toHaveBeenCalledWith(
      'https://memrynote.com/download',
      '_blank',
      'noopener,noreferrer'
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    open.mockRestore()
  })

  it('can be dismissed for the session', async () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })

    render(<UpdateInstallFailedDialog />)
    await userEvent.click(screen.getByRole('button', { name: /later/i }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
