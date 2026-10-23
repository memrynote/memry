import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

const mocks = vi.hoisted(() => ({
  state: {} as AppUpdateState,
  checkForUpdates: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({ state: mocks.state, checkForUpdates: mocks.checkForUpdates })
}))

import {
  UpdateInstallFailedDialog,
  shouldShowInstallFailedPrompt
} from './update-install-failed-dialog'
import { reopenInstallFailed, resetInstallFailedDismissal } from './install-failed-dismissal'

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
    autoDownloadEnabled: false,
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
    // The dismissal store is module-level, so it outlives a render tree.
    resetInstallFailedDismissal()
    vi.clearAllMocks()
  })

  it('renders nothing on a normal launch', () => {
    const { container } = render(<UpdateInstallFailedDialog />)
    expect(container).toBeEmptyDOMElement()
  })

  it('leads with the vault, then names both versions', () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })

    render(<UpdateInstallFailedDialog />)

    // The first thing a user needs to know is that their notes were never at risk.
    expect(screen.getByText(/Your vault was never touched/)).toBeInTheDocument()
    expect(screen.getByText(/2026\.700\.1/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /v1\.2\.7/ })).toBeInTheDocument()
  })

  it('still explains the failure when the target version is unknown', () => {
    mocks.state = state({ installFailed: { version: null } })

    render(<UpdateInstallFailedDialog />)

    // Falls back to the version-less copy rather than rendering a raw
    // placeholder or hiding the failure entirely.
    expect(
      screen.getByRole('heading', { name: /couldn't finish installing the update/i })
    ).toBeInTheDocument()
  })

  it('shows the raw installer error under its own label', () => {
    mocks.state = state({
      installFailed: { version: 'v1.2.7' },
      error: 'EPERM: operation not permitted, rename'
    })

    render(<UpdateInstallFailedDialog />)

    expect(screen.getByText('What went wrong')).toBeInTheDocument()
    expect(screen.getByText(/EPERM: operation not permitted/)).toBeInTheDocument()
  })

  it('omits the error block when the installer reported nothing', () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' }, error: null })

    render(<UpdateInstallFailedDialog />)

    expect(screen.queryByText('What went wrong')).not.toBeInTheDocument()
  })

  it('hands the user the manual installer and closes', async () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)

    render(<UpdateInstallFailedDialog />)
    await userEvent.click(screen.getByRole('button', { name: /download v1\.2\.7 manually/i }))

    expect(open).toHaveBeenCalledWith(
      'https://memrynote.com/download/desktop',
      '_blank',
      'noopener,noreferrer'
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    open.mockRestore()
  })

  it('re-checks for updates from "Try again"', async () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })

    render(<UpdateInstallFailedDialog />)
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('copies the failure details for a bug report', async () => {
    mocks.state = state({
      installFailed: { version: 'v1.2.7' },
      error: 'EPERM: operation not permitted, rename'
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    render(<UpdateInstallFailedDialog />)
    await userEvent.click(screen.getByRole('button', { name: /copy details/i }))

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('EPERM: operation not permitted, rename')
    )
    vi.unstubAllGlobals()
  })

  it('can be dismissed for the session and brought back from the sidebar', async () => {
    mocks.state = state({ installFailed: { version: 'v1.2.7' } })

    const view = render(<UpdateInstallFailedDialog />)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // "Details" on the sidebar row is the way back in.
    act(() => reopenInstallFailed())
    view.rerender(<UpdateInstallFailedDialog />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
