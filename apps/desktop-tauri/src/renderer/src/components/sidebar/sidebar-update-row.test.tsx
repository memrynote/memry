import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarUpdateRow } from './sidebar-update-row'

const mocks = vi.hoisted(() => ({
  reopenInstallFailed: vi.fn(),
  state: {} as AppUpdateState
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({
    state: mocks.state,
    isLoading: false,
    error: null,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  })
}))

vi.mock('@/components/updater/install-failed-dismissal', () => ({
  reopenInstallFailed: mocks.reopenInstallFailed
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const leaf = key.split('.').at(-1) ?? key
      return opts && 'version' in opts ? `${leaf}-${opts.version}` : leaf
    }
  })
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

describe('SidebarUpdateRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when there is no update to talk about', () => {
    mocks.state = makeState({ status: 'up-to-date' })
    const { container } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('leaves available and ready updates to the settings gear', () => {
    mocks.state = makeState({ status: 'available', availableVersion: '2026.999.9' })
    const { container, rerender } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()

    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    rerender(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while the app is installing and on its way out', () => {
    mocks.state = makeState({ status: 'installing', availableVersion: '2026.999.9' })
    const { container } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the version while downloading and offers no verb', () => {
    mocks.state = makeState({
      status: 'downloading',
      availableVersion: '2026.999.9',
      downloadProgressPercent: 40
    })
    render(<SidebarUpdateRow />)

    expect(screen.getByText('downloading-2026.999.9')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('update-popover')).not.toBeInTheDocument()
  })

  it('draws the progress hairline at the reported percent', () => {
    mocks.state = makeState({
      status: 'downloading',
      availableVersion: '2026.999.9',
      downloadProgressPercent: 40
    })
    const { container } = render(<SidebarUpdateRow />)
    expect(container.querySelector('[style*="width: 40%"]')).not.toBeNull()
  })

  it('draws no hairline before the first progress tick', () => {
    mocks.state = makeState({ status: 'downloading', availableVersion: '2026.999.9' })
    const { container } = render(<SidebarUpdateRow />)
    expect(container.querySelector('[style*="width"]')).toBeNull()
  })

  it('stays silent for a background download the app started itself', () => {
    mocks.state = makeState({
      status: 'downloading',
      availableVersion: '2026.999.9',
      autoDownloadEnabled: true,
      downloadProgressPercent: 40
    })
    const { container } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reopens the recovery dialog from a failed install', () => {
    mocks.state = makeState({ installFailed: { version: '2026.998.1' } })
    render(<SidebarUpdateRow />)

    expect(screen.getByRole('button', { name: 'failed' })).toBeInTheDocument()
    expect(screen.queryByTestId('update-popover')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'detailsAction' }))
    expect(mocks.reopenInstallFailed).toHaveBeenCalled()
  })

  it('stays hidden where updates are not supported (dev builds)', () => {
    mocks.state = makeState({
      updateSupported: false,
      status: 'downloaded',
      availableVersion: '2026.999.9'
    })
    const { container } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })
})
