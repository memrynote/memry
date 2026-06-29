import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarUpdateButton } from './sidebar-update-button'

const mocks = vi.hoisted(() => ({
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  state: {} as AppUpdateState
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({
    state: mocks.state,
    isLoading: false,
    error: null,
    checkForUpdates: vi.fn(),
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: mocks.quitAndInstall
  })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const leaf = key.split('.').at(-1) ?? key
      return opts && 'percent' in opts ? `${leaf}-${opts.percent}` : leaf
    }
  })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/icons', () => ({
  Download: () => <svg data-testid="icon-download" />,
  RotateCw: () => <svg data-testid="icon-restart" />
}))

function makeState(patch: Partial<AppUpdateState>): AppUpdateState {
  return {
    currentVersion: '1.0.0',
    status: 'idle',
    updateSupported: true,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    ...patch
  }
}

describe('SidebarUpdateButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['idle', 'checking', 'up-to-date', 'unavailable', 'error'] as const)(
    'renders nothing in %s state',
    (status) => {
      mocks.state = makeState({ status })
      const { container } = render(<SidebarUpdateButton />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it('shows "Update" and downloads when available', () => {
    mocks.state = makeState({ status: 'available', availableVersion: '1.1.0' })
    render(<SidebarUpdateButton />)

    const button = screen.getByRole('button', { name: 'updateAvailable' })
    fireEvent.click(button)
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.quitAndInstall).not.toHaveBeenCalled()
  })

  it('shows live percent and disables the button while downloading', () => {
    mocks.state = makeState({ status: 'downloading', downloadProgressPercent: 42 })
    render(<SidebarUpdateButton />)

    const button = screen.getByRole('button', { name: 'updateDownloadingPercent-42' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.downloadUpdate).not.toHaveBeenCalled()
  })

  it('shows "Restart" and installs when downloaded', () => {
    mocks.state = makeState({ status: 'downloaded', downloadProgressPercent: 100 })
    render(<SidebarUpdateButton />)

    const button = screen.getByRole('button', { name: 'updateRestart' })
    fireEvent.click(button)
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(mocks.downloadUpdate).not.toHaveBeenCalled()
  })
})
