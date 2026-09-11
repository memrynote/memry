import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

import { UpdatePopover, parseHighlights } from './update-popover'

const mocks = vi.hoisted(() => ({
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn().mockResolvedValue(undefined),
  skipVersion: vi.fn().mockResolvedValue(undefined),
  setAutoDownload: vi.fn().mockResolvedValue(undefined),
  openTab: vi.fn()
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: mocks.quitAndInstall,
    skipVersion: mocks.skipVersion,
    setAutoDownload: mocks.setAutoDownload
  })
}))

vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab: mocks.openTab }) }))

vi.mock('@/components/ui/popover', () => ({
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const leaf = key.split('.').at(-1) ?? key
      const arg = opts?.version ?? opts?.current
      return arg ? `${leaf}-${arg}` : leaf
    }
  })
}))

function state(patch: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'downloaded',
    updateSupported: true,
    availableVersion: '2026.999.9',
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

describe('parseHighlights', () => {
  it('returns nothing without release notes', () => {
    expect(parseHighlights(null)).toEqual([])
    expect(parseHighlights('   \n\n  ')).toEqual([])
  })

  it('takes the first three lines only', () => {
    expect(parseHighlights('one\ntwo\nthree\nfour')).toEqual(['one', 'two', 'three'])
  })

  it('strips list markers and leading emoji', () => {
    expect(parseHighlights('- 📥 Inbox reminder\n* Darker theme\n1. 🔄 Smarter sync')).toEqual([
      'Inbox reminder',
      'Darker theme',
      'Smarter sync'
    ])
  })

  it('skips blank lines rather than counting them', () => {
    expect(parseHighlights('one\n\n\ntwo')).toEqual(['one', 'two'])
  })
})

describe('UpdatePopover', () => {
  beforeEach(() => vi.clearAllMocks())

  it('restarts and closes from the ready phase', () => {
    const onClose = vi.fn()
    render(<UpdatePopover kind="ready" version="2026.999.9" state={state()} onClose={onClose} />)

    expect(screen.getByText('readyTitle-2026.999.9')).toBeInTheDocument()
    expect(screen.getByText('readySubtitle-2026.700.1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'restartNow' }))
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes and does nothing else on "On next quit"', () => {
    const onClose = vi.fn()
    render(<UpdatePopover kind="ready" version="2026.999.9" state={state()} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'onNextQuit' }))
    // The product promise: no re-prompt, no timer, no toast.
    expect(onClose).toHaveBeenCalled()
    expect(mocks.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.skipVersion).not.toHaveBeenCalled()
  })

  it('downloads from the available phase', () => {
    const onClose = vi.fn()
    render(
      <UpdatePopover
        kind="available"
        version="2026.999.9"
        state={state({ status: 'available' })}
        onClose={onClose}
      />
    )

    expect(screen.getByText('availableTitle-2026.999.9')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('omits the highlights section when there are no notes', () => {
    render(<UpdatePopover kind="ready" version="2026.999.9" state={state()} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /allChanges/ })).not.toBeInTheDocument()
  })

  it('opens the release-notes tab from "All changes"', () => {
    render(
      <UpdatePopover
        kind="ready"
        version="2026.999.9"
        state={state({ releaseNotes: '- One\n- Two', releaseNotesHtml: '<p>One</p>' })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('One')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /allChanges/ }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/virtual/release-notes/2026.999.9' })
    )
  })

  it('holds skip and auto-update off in the overflow menu', () => {
    render(<UpdatePopover kind="ready" version="2026.999.9" state={state()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'skipVersion-2026.999.9' }))
    expect(mocks.skipVersion).toHaveBeenCalledWith('2026.999.9')

    fireEvent.click(screen.getByRole('button', { name: 'turnOffAuto' }))
    expect(mocks.setAutoDownload).toHaveBeenCalledWith(false)
  })
})
