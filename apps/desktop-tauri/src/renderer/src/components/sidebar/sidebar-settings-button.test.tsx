import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarSettingsButton } from './sidebar-settings-button'

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  state: {} as AppUpdateState
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({ state: mocks.state })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/updater/update-popover', () => ({
  UpdatePopover: ({ kind, onOpenSettings }: { kind: string; onOpenSettings?: () => void }) => (
    <div data-testid="update-popover">
      {kind}
      <button type="button" onClick={onOpenSettings}>
        open-settings
      </button>
    </div>
  )
}))

function makeState(patch: Partial<AppUpdateState>): AppUpdateState {
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
    ...patch
  }
}

describe('SidebarSettingsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens settings directly when no update is waiting', () => {
    mocks.state = makeState({})
    render(<SidebarSettingsButton />)

    expect(screen.queryByTestId('dock-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('update-popover')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'settings' }))
    expect(mocks.openSettings).toHaveBeenCalledTimes(1)
  })

  it('badges the gear and offers the update popover once an update is ready', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarSettingsButton />)

    expect(screen.getByTestId('dock-badge')).toHaveAttribute('data-tone', 'tint')
    expect(screen.getByRole('button', { name: 'settings · ready' })).toBeInTheDocument()
    expect(screen.getByTestId('update-popover')).toHaveTextContent('ready')

    fireEvent.click(screen.getByRole('button', { name: 'open-settings' }))
    expect(mocks.openSettings).toHaveBeenCalledTimes(1)
  })

  it('leaves a background download silent', () => {
    mocks.state = makeState({
      status: 'downloading',
      availableVersion: '2026.999.9',
      autoDownloadEnabled: true
    })
    render(<SidebarSettingsButton />)
    expect(screen.queryByTestId('dock-badge')).not.toBeInTheDocument()
  })
})
