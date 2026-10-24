import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SIDEBAR_NOTES_FIRST_SETTINGS_KEY,
  SIDEBAR_SHOW_FILES_SETTINGS_KEY,
  useSidebarTreeViewOptions
} from './use-sidebar-tree-view-options'

const realApi = window.api

afterEach(() => {
  window.api = realApi
})

type SettingsListener = (event: { key: string; value: unknown }) => void

const withApi = (
  settings: Partial<typeof realApi.settings>,
  onSettingsChanged: (listener: SettingsListener) => unknown = () => () => {}
): void => {
  // SAFETY: a test host; only the settings members this hook reads are replaced.
  window.api = {
    ...realApi,
    settings: { ...realApi.settings, ...settings },
    onSettingsChanged: vi.fn(onSettingsChanged)
  } as unknown as typeof realApi
}

describe('useSidebarTreeViewOptions', () => {
  // Every host without the channel, and every install without a stored row,
  // gets the tree it always had.
  it('defaults to folders first and files shown on a host with no settings channel', async () => {
    // SAFETY: a host exposing no settings channel is the shape the optional
    // chaining exists for.
    window.api = {
      ...realApi,
      settings: undefined,
      onSettingsChanged: undefined
    } as unknown as typeof realApi

    const { result, unmount } = renderHook(() => useSidebarTreeViewOptions())

    await waitFor(() => expect(result.current.notesFirst).toBe(false))
    expect(result.current.showFiles).toBe(true)
    expect(result.current.error).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('loads both stored flags', async () => {
    withApi({
      getSidebarNotesFirst: vi.fn(() => Promise.resolve(true)),
      getSidebarShowFiles: vi.fn(() => Promise.resolve(false))
    })

    const { result } = renderHook(() => useSidebarTreeViewOptions())

    await waitFor(() => expect(result.current.notesFirst).toBe(true))
    expect(result.current.showFiles).toBe(false)
  })

  it('keeps the defaults when the stored flags cannot be read', async () => {
    const getSidebarNotesFirst = vi.fn(() => Promise.reject(new Error('db closed')))
    withApi({
      getSidebarNotesFirst,
      getSidebarShowFiles: vi.fn(() => Promise.reject(new Error('db closed')))
    })

    const { result } = renderHook(() => useSidebarTreeViewOptions())

    await waitFor(() => expect(getSidebarNotesFirst).toHaveBeenCalled())
    expect(result.current.notesFirst).toBe(false)
    expect(result.current.showFiles).toBe(true)
  })

  it('keeps the defaults when subscribing to changes throws', async () => {
    const getSidebarNotesFirst = vi.fn(() => Promise.resolve(true))
    withApi(
      { getSidebarNotesFirst, getSidebarShowFiles: vi.fn(() => Promise.resolve(false)) },
      () => {
        throw new Error('no settings channel')
      }
    )

    const { result, unmount } = renderHook(() => useSidebarTreeViewOptions())

    // The stored values still load; only live updates are lost.
    await waitFor(() => expect(result.current.notesFirst).toBe(true))
    expect(result.current.showFiles).toBe(false)
    expect(() => unmount()).not.toThrow()
  })

  // A change synced in or made in another window. `false` must land too.
  it('follows settings changes for its own keys only, false included', async () => {
    // One subscription per flag, like the preload fans each change out to all.
    const listeners: SettingsListener[] = []
    const listener: SettingsListener = (event) => listeners.forEach((l) => l(event))
    withApi(
      {
        getSidebarNotesFirst: vi.fn(() => Promise.resolve(false)),
        getSidebarShowFiles: vi.fn(() => Promise.resolve(true))
      },
      (next) => {
        listeners.push(next)
        return () => {}
      }
    )

    const { result } = renderHook(() => useSidebarTreeViewOptions())
    await waitFor(() => expect(window.api.onSettingsChanged).toHaveBeenCalled())

    act(() => listener({ key: SIDEBAR_NOTES_FIRST_SETTINGS_KEY, value: true }))
    act(() => listener({ key: SIDEBAR_SHOW_FILES_SETTINGS_KEY, value: false }))
    expect(result.current.notesFirst).toBe(true)
    expect(result.current.showFiles).toBe(false)

    act(() => listener({ key: 'sidebar.navCollapsed', value: false }))
    act(() => listener({ key: SIDEBAR_NOTES_FIRST_SETTINGS_KEY, value: 'yes' }))
    expect(result.current.notesFirst).toBe(true)

    act(() => listener({ key: SIDEBAR_NOTES_FIRST_SETTINGS_KEY, value: false }))
    expect(result.current.notesFirst).toBe(false)
  })

  it('writes optimistically through the matching setter', async () => {
    const setSidebarNotesFirst = vi.fn(() => Promise.resolve({ success: true }))
    const setSidebarShowFiles = vi.fn(() => Promise.resolve({ success: true }))
    withApi({
      getSidebarNotesFirst: vi.fn(() => Promise.resolve(false)),
      getSidebarShowFiles: vi.fn(() => Promise.resolve(true)),
      setSidebarNotesFirst,
      setSidebarShowFiles
    })

    const { result } = renderHook(() => useSidebarTreeViewOptions())
    await waitFor(() => expect(window.api.settings.getSidebarShowFiles).toHaveBeenCalled())

    act(() => result.current.setNotesFirst(true))
    expect(result.current.notesFirst).toBe(true)
    act(() => result.current.setShowFiles(false))
    expect(result.current.showFiles).toBe(false)

    await waitFor(() => expect(setSidebarShowFiles).toHaveBeenCalledWith(false))
    expect(setSidebarNotesFirst).toHaveBeenCalledWith(true)
    expect(result.current.error).toBeNull()
  })

  it('rolls back and surfaces the message when a write fails', async () => {
    withApi({
      getSidebarNotesFirst: vi.fn(() => Promise.resolve(false)),
      getSidebarShowFiles: vi.fn(() => Promise.resolve(true)),
      setSidebarNotesFirst: vi.fn(() => Promise.reject(new Error('disk is read-only'))),
      setSidebarShowFiles: vi.fn(() => Promise.resolve({ success: false, error: 'locked' }))
    })

    const { result } = renderHook(() => useSidebarTreeViewOptions())
    await waitFor(() => expect(window.api.settings.getSidebarShowFiles).toHaveBeenCalled())

    await act(async () => {
      result.current.setNotesFirst(true)
    })
    await waitFor(() => expect(result.current.notesFirst).toBe(false))
    expect(result.current.error).toBe('disk is read-only')

    await act(async () => {
      result.current.setShowFiles(false)
    })
    await waitFor(() => expect(result.current.showFiles).toBe(true))
  })
})
