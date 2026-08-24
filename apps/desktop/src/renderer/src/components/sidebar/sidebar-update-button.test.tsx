import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarUpdateButton } from './sidebar-update-button'

const mocks = vi.hoisted(() => ({
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  state: {} as AppUpdateState
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({
    state: mocks.state,
    isLoading: false,
    error: null,
    checkForUpdates: vi.fn(),
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

  // Downloads are silent: the button surfaces nothing until a restart can apply
  // the update.
  it.each([
    'idle',
    'checking',
    'up-to-date',
    'unavailable',
    'error',
    'available',
    'downloading'
  ] as const)('renders nothing in %s state', (status) => {
    mocks.state = makeState({ status })
    const { container } = render(<SidebarUpdateButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows "Restart" and installs when downloaded', () => {
    mocks.state = makeState({ status: 'downloaded', downloadProgressPercent: 100 })
    render(<SidebarUpdateButton />)

    const button = screen.getByRole('button', { name: 'updateRestart' })
    fireEvent.click(button)
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
