import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { WhatsNewPayload } from '@memry/contracts/ipc-updater'

const mocks = vi.hoisted(() => ({
  consumeWhatsNew: vi.fn<() => Promise<WhatsNewPayload | null>>(),
  openTab: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))

import { UpdateReleaseNotesTabOpener } from './update-release-notes-tab-opener'

describe('UpdateReleaseNotesTabOpener', () => {
  beforeEach(() => {
    mocks.openTab.mockReset()
    mocks.consumeWhatsNew.mockReset()
    // setup-dom already installed window.api; only the consume call is swapped.
    ;(window.api.updater as { consumeWhatsNew: unknown }).consumeWhatsNew = mocks.consumeWhatsNew
  })

  it('opens the whats-new tab when the first post-install launch has a payload', async () => {
    mocks.consumeWhatsNew.mockResolvedValue({
      version: '2026.708.1',
      content: '<p>2026.708.1</p>',
      contentType: 'html'
    })
    render(<UpdateReleaseNotesTabOpener />)

    await waitFor(() => expect(mocks.openTab).toHaveBeenCalledTimes(1))
    const tab = mocks.openTab.mock.calls[0][0]
    expect(tab).toMatchObject({
      type: 'virtual-note',
      title: 'MemryNote 2026.708.1',
      path: '/virtual/release-notes/2026.708.1',
      isPreview: false,
      viewState: { content: '<p>2026.708.1</p>', contentType: 'html' }
    })
  })

  it('consumes only once even across re-renders', async () => {
    mocks.consumeWhatsNew.mockResolvedValue(null)
    const { rerender } = render(<UpdateReleaseNotesTabOpener />)
    rerender(<UpdateReleaseNotesTabOpener />)

    await waitFor(() => expect(mocks.consumeWhatsNew).toHaveBeenCalledTimes(1))
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('stays quiet on an ordinary launch with no pending notes', async () => {
    mocks.consumeWhatsNew.mockResolvedValue(null)
    render(<UpdateReleaseNotesTabOpener />)

    await waitFor(() => expect(mocks.consumeWhatsNew).toHaveBeenCalled())
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('never lets a consume failure break mounting', async () => {
    mocks.consumeWhatsNew.mockRejectedValue(new Error('ipc down'))
    render(<UpdateReleaseNotesTabOpener />)

    await waitFor(() => expect(mocks.consumeWhatsNew).toHaveBeenCalled())
    expect(mocks.openTab).not.toHaveBeenCalled()
  })
})
