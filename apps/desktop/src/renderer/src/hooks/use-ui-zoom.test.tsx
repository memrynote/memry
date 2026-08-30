import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { UiZoomChangedEvent } from '@memry/contracts/ui-zoom'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

import { useUiZoom } from './use-ui-zoom'

let listener: ((event: UiZoomChangedEvent) => void) | null = null
let persisted = 1

function stubZoomApi() {
  const set = vi.fn(async (factor: number) => {
    persisted = factor
    return factor
  })
  Object.assign(window.api, {
    uiZoom: {
      get: vi.fn(async () => persisted),
      set
    },
    onUiZoomChanged: vi.fn((callback: (event: UiZoomChangedEvent) => void) => {
      listener = callback
      return () => {
        listener = null
      }
    })
  })
  return set
}

describe('useUiZoom', () => {
  beforeEach(() => {
    persisted = 1
    listener = null
  })

  it('#given a persisted zoom #then the hook reports it once read', async () => {
    persisted = 1.5
    stubZoomApi()

    const { result } = renderHook(() => useUiZoom())

    await waitFor(() => expect(result.current.factor).toBe(1.5))
  })

  it('#given zoom in #then it steps up exactly one rung and persists it', async () => {
    stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(1))

    act(() => result.current.zoomIn())

    expect(result.current.factor).toBe(1.15)
    await waitFor(() => expect(persisted).toBe(1.15))
  })

  it('#given three zoom-in presses in one commit #then each one advances a rung', async () => {
    const set = stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(1))

    // A held ⌘+ repeats faster than React commits. Stepping from the rendered
    // value would collapse this burst onto a single rung.
    act(() => {
      result.current.zoomIn()
      result.current.zoomIn()
      result.current.zoomIn()
    })

    expect(result.current.factor).toBe(1.5)
    expect(set).toHaveBeenLastCalledWith(1.5)
  })

  it('#given zoom out at the bottom rung #then it saturates instead of wrapping', async () => {
    persisted = 0.75
    stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(0.75))

    act(() => result.current.zoomOut())

    expect(result.current.factor).toBe(0.75)
  })

  it('#given an off-ladder factor #then it snaps to the nearest rung', async () => {
    stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(1))

    act(() => result.current.setFactor(1.28))

    expect(result.current.factor).toBe(1.3)
  })

  it('#given a zoom change made elsewhere #then the hook adopts the broadcast value', async () => {
    stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(1))

    act(() => listener?.({ factor: 1.75 }))

    expect(result.current.factor).toBe(1.75)
  })

  it('#given a zoomed app #when reset #then it returns to actual size', async () => {
    persisted = 2
    const set = stubZoomApi()
    const { result } = renderHook(() => useUiZoom())
    await waitFor(() => expect(result.current.factor).toBe(2))

    act(() => result.current.resetZoom())

    expect(result.current.factor).toBe(1)
    expect(set).toHaveBeenLastCalledWith(1)
  })
})
