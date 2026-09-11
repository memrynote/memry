import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { SidebarUpdateRow } from './sidebar-update-row'

const mocks = vi.hoisted(() => ({
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  reopenInstallFailed: vi.fn(),
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
  UpdatePopover: ({
    kind,
    version,
    onMouseEnter,
    onMouseLeave
  }: {
    kind: string
    version: string
    onMouseEnter?: () => void
    onMouseLeave?: () => void
  }) => (
    <div data-testid="update-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {`${kind}:${version}`}
    </div>
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-testid="popover" data-open={String(open)}>
      {children}
    </div>
  ),
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>
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

function isOpen(): boolean {
  return screen.getByTestId('popover').getAttribute('data-open') === 'true'
}

/** The hover target is the positioned wrapper, not either button inside it. */
function rowContainer(): HTMLElement {
  const row = screen.getByTestId('popover').querySelector('.group\\/update')
  if (!row) throw new Error('row container not rendered')
  return row as HTMLElement
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
    expect(isOpen()).toBe(false)
  })

  it('opens and closes the popover on the row click', () => {
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.click(screen.getByRole('button', { name: 'ready' }))
    expect(isOpen()).toBe(true)
    expect(mocks.quitAndInstall).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'ready' }))
    expect(isOpen()).toBe(false)
  })

  it('opens on hover, but only after the user has settled on the row', () => {
    vi.useFakeTimers()
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.mouseEnter(rowContainer())
    act(() => void vi.advanceTimersByTime(399))
    expect(isOpen()).toBe(false)

    act(() => void vi.advanceTimersByTime(1))
    expect(isOpen()).toBe(true)
    vi.useRealTimers()
  })

  it('ignores a pointer merely crossing the row on its way elsewhere', () => {
    vi.useFakeTimers()
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.mouseEnter(rowContainer())
    act(() => void vi.advanceTimersByTime(150))
    fireEvent.mouseLeave(rowContainer())
    act(() => void vi.advanceTimersByTime(2000))
    expect(isOpen()).toBe(false)
    vi.useRealTimers()
  })

  it('survives the trip from the row into the panel', () => {
    vi.useFakeTimers()
    mocks.state = makeState({ status: 'downloaded', availableVersion: '2026.999.9' })
    render(<SidebarUpdateRow />)

    fireEvent.mouseEnter(rowContainer())
    act(() => void vi.advanceTimersByTime(400))
    expect(isOpen()).toBe(true)

    fireEvent.mouseLeave(rowContainer())
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.mouseEnter(screen.getByTestId('update-popover'))
    act(() => void vi.advanceTimersByTime(2000))
    expect(isOpen()).toBe(true)
    vi.useRealTimers()
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
