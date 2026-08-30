/**
 * The hook's failure paths.
 *
 * The happy path is covered through the component in
 * `components/sidebar/sidebar-nav.test.tsx`. What is left here is everything
 * that goes wrong at the preload boundary, where the rule is the same in all
 * three cases: the nav keeps rendering.
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useSidebarNavCollapsed } from './use-sidebar-nav-collapsed'

const realApi = window.api

afterEach(() => {
  window.api = realApi
})

describe('useSidebarNavCollapsed', () => {
  it('leaves the nav expanded on a host with no settings channel', async () => {
    // A host that exposes no settings channel at all is the shape the hook's
    // optional chaining exists for, so the stub has to be allowed to be it.
    window.api = {
      ...realApi,
      settings: undefined,
      onSettingsChanged: undefined
    } as unknown as typeof realApi

    const { result, unmount } = renderHook(() => useSidebarNavCollapsed())

    await waitFor(() => expect(result.current.collapsed).toBe(false))
    expect(result.current.error).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('leaves the nav expanded when the stored flag cannot be read', async () => {
    const getSidebarNavCollapsed = vi.fn(() => Promise.reject(new Error('db closed')))
    window.api = {
      ...realApi,
      settings: { ...realApi.settings, getSidebarNavCollapsed },
      onSettingsChanged: vi.fn(() => () => {})
    } as typeof realApi

    const { result } = renderHook(() => useSidebarNavCollapsed())

    await waitFor(() => expect(getSidebarNavCollapsed).toHaveBeenCalled())
    expect(result.current.collapsed).toBe(false)
  })

  it('keeps rendering when the settings subscription throws', async () => {
    window.api = {
      ...realApi,
      settings: {
        ...realApi.settings,
        getSidebarNavCollapsed: vi.fn(() => Promise.resolve(true))
      },
      onSettingsChanged: vi.fn(() => {
        throw new Error('no listener channel')
      })
    } as typeof realApi

    const { result, unmount } = renderHook(() => useSidebarNavCollapsed())

    // The stored flag still lands: a dead subscription costs later updates, not
    // the value this window started from.
    await waitFor(() => expect(result.current.collapsed).toBe(true))
    expect(() => unmount()).not.toThrow()
  })

  it('unmounts cleanly when the host hands back no unsubscribe', async () => {
    window.api = {
      ...realApi,
      settings: {
        ...realApi.settings,
        getSidebarNavCollapsed: vi.fn(() => Promise.resolve(false))
      },
      onSettingsChanged: vi.fn(() => undefined)
    } as unknown as typeof realApi

    const { unmount } = renderHook(() => useSidebarNavCollapsed())

    await waitFor(() => expect(window.api.onSettingsChanged).toHaveBeenCalled())
    expect(() => unmount()).not.toThrow()
  })

  it('rolls the nav back and surfaces the message when the write throws', async () => {
    window.api = {
      ...realApi,
      settings: {
        ...realApi.settings,
        getSidebarNavCollapsed: vi.fn(() => Promise.resolve(false)),
        setSidebarNavCollapsed: vi.fn(() => Promise.reject(new Error('disk is read-only')))
      },
      onSettingsChanged: vi.fn(() => () => {})
    } as typeof realApi

    const { result } = renderHook(() => useSidebarNavCollapsed())
    await waitFor(() => expect(window.api.settings.getSidebarNavCollapsed).toHaveBeenCalled())

    await act(async () => {
      result.current.setCollapsed(true)
    })

    await waitFor(() => expect(result.current.collapsed).toBe(false))
    expect(result.current.error).toBe('disk is read-only')
  })
})
