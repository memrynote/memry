import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarUpdateRow } from './sidebar-update-row'

const mocks = vi.hoisted(() => ({
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  reopenInstallFailed: vi.fn(),
  openPopover: vi.fn(),
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

vi.mock('@/components/updater/install-failed-dismissal', () => ({
  reopenInstallFailed: mocks.reopenInstallFailed
}))

vi.mock('@/components/updater/update-popover', () => ({
  UpdatePopover: ({ kind, version }: { kind: string; version: string }) => (
    <div data-testid="update-popover">{`${kind}:${version}`}</div>
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div data-testid="popover">{children}</div>,
  // Mirrors Radix `asChild`: the trigger hands its onClick to the child element, so
  // anything nested inside the row bubbles into it unless it stops first.
  PopoverTrigger: ({ children }: { children: ReactNode }) =>
    cloneElement(children as ReactElement<{ onClick?: () => void }>, {
      onClick: mocks.openPopover
    })
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

  it('renders nothing while the app is installing and on its way out', () => {
    mocks.state = makeState({ status: 'installing', availableVersion: '2026.999.9' })
    const { container } = render(<SidebarUpdateRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers the version at rest and downloads from the trailing verb', () => {
    mocks.state = makeState({ status: 'available', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    expect(screen.getByRole('button', { name: 'available' })).toBeInTheDocument()
    expect(screen.getByText('2026.999.9')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'downloadAction' }))
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('acts from the trailing verb without also opening the popover', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.click(screen.getByRole('button', { name: 'restartAction' }))
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(mocks.openPopover).not.toHaveBeenCalled()
  })

  it('opens the popover when the row itself is clicked', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.click(screen.getByRole('button', { name: 'ready' }))
    expect(mocks.openPopover).toHaveBeenCalledTimes(1)
    expect(mocks.quitAndInstall).not.toHaveBeenCalled()
  })

  it('restarts from the trailing verb once an update is ready', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    expect(screen.getByRole('button', { name: 'ready' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'restartAction' }))
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('anchors the popover to the row for a decidable phase', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)
    expect(screen.getByTestId('update-popover')).toHaveTextContent('ready:2026.999.9')
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
