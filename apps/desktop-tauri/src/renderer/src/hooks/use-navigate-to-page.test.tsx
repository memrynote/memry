import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigateToPage } from './use-navigate-to-page'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  closeSettings: vi.fn(),
  settingsOpen: false
}))

vi.mock('./use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ isOpen: mocks.settingsOpen, close: mocks.closeSettings })
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settingsOpen = false
})

describe('useNavigateToPage', () => {
  it('opens the page as the sidebar does, and lands Tasks and Inbox ready to add', () => {
    const { result } = renderHook(useNavigateToPage)

    result.current('journal')
    result.current('tasks')
    result.current('inbox')

    expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(
      1,
      { type: 'journal', title: 'Journal', path: '/journal', viewState: undefined },
      {}
    )
    expect(mocks.openSidebarItem.mock.calls[1][0]).toMatchObject({
      type: 'tasks',
      viewState: { activeInternalTab: 'all', focusQuickAddAt: expect.any(Number) }
    })
    expect(mocks.openSidebarItem.mock.calls[2][0]).toMatchObject({
      type: 'inbox',
      viewState: { focusCaptureAt: expect.any(Number) }
    })
  })

  it('opens Tags, which has no rail icon', () => {
    const { result } = renderHook(useNavigateToPage)
    result.current('tags')
    expect(mocks.openSidebarItem.mock.calls[0][0]).toMatchObject({ type: 'tags', path: '/tags' })
  })

  it('passes the open options on, and lets a caller replace the view state', () => {
    const { result } = renderHook(useNavigateToPage)

    result.current('calendar', { inNewTab: true, viewState: { createEventAt: 1 } })

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'calendar', viewState: { createEventAt: 1 } }),
      { inNewTab: true }
    )
  })

  it('leaves Settings, which covers the workspace, on the way to a page', () => {
    mocks.settingsOpen = true
    const { result } = renderHook(useNavigateToPage)

    result.current('home')

    expect(mocks.closeSettings).toHaveBeenCalledTimes(1)
    expect(mocks.openSidebarItem).toHaveBeenCalledTimes(1)
  })
})
