import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

const mocks = vi.hoisted(() => ({
  state: {} as AppUpdateState,
  openTab: vi.fn()
}))

vi.mock('@/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({ state: mocks.state })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))

import { UpdateReleaseNotesTabOpener } from './update-release-notes-tab-opener'

function available(version: string): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'available',
    updateSupported: true,
    availableVersion: version,
    releaseName: null,
    releaseDate: null,
    releaseNotes: 'notes',
    releaseNotesHtml: `<p>${version}</p>`,
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true
  }
}

describe('UpdateReleaseNotesTabOpener', () => {
  beforeEach(() => {
    mocks.openTab.mockReset()
  })

  it('opens a read-only release-notes tab once when an update surfaces', () => {
    mocks.state = available('2026.708.1')
    render(<UpdateReleaseNotesTabOpener />)

    expect(mocks.openTab).toHaveBeenCalledTimes(1)
    const tab = mocks.openTab.mock.calls[0][0]
    expect(tab).toMatchObject({
      type: 'virtual-note',
      title: 'MemryNote 2026.708.1',
      path: '/virtual/release-notes/2026.708.1',
      isPreview: false,
      viewState: { content: '<p>2026.708.1</p>', contentType: 'html' }
    })
    expect(mocks.openTab.mock.calls[0][1]).toMatchObject({ background: true })
  })

  it('does not re-open the same version on a re-render', () => {
    mocks.state = available('2026.708.1')
    const { rerender } = render(<UpdateReleaseNotesTabOpener />)
    expect(mocks.openTab).toHaveBeenCalledTimes(1)

    mocks.state = { ...available('2026.708.1'), status: 'downloading' }
    rerender(<UpdateReleaseNotesTabOpener />)
    expect(mocks.openTab).toHaveBeenCalledTimes(1)
  })

  it('opens again for a newer version', () => {
    mocks.state = available('2026.708.1')
    const { rerender } = render(<UpdateReleaseNotesTabOpener />)
    mocks.state = available('2026.709.1')
    rerender(<UpdateReleaseNotesTabOpener />)
    expect(mocks.openTab).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when there is no update to surface', () => {
    mocks.state = { ...available('2026.708.1'), status: 'up-to-date', availableVersion: null }
    render(<UpdateReleaseNotesTabOpener />)
    expect(mocks.openTab).not.toHaveBeenCalled()
  })
})
