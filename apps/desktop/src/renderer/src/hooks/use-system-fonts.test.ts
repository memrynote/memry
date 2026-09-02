import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSystemFonts } from './use-system-fonts'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

function stubQueryLocalFonts(
  impl: () => Promise<Array<{ family: string }>>
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl)
  window.queryLocalFonts = spy
  return spy
}

afterEach(() => {
  delete window.queryLocalFonts
})

describe('useSystemFonts', () => {
  it('#given it is disabled #when rendered #then it never queries', () => {
    const query = stubQueryLocalFonts(async () => [{ family: 'Inter' }])

    const { result } = renderHook(() => useSystemFonts(false))

    expect(result.current).toEqual({ status: 'idle' })
    expect(query).not.toHaveBeenCalled()
  })

  it('#given no Local Font Access API #when enabled #then it reports unavailable', async () => {
    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }))
  })

  it('#given the query rejects #when enabled #then it reports unavailable', async () => {
    stubQueryLocalFonts(() => Promise.reject(new Error('permission denied')))

    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }))
  })

  it('#given no faces come back #when enabled #then it reports unavailable', async () => {
    stubQueryLocalFonts(async () => [])

    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }))
  })

  it('#given repeated and unusable families #when enabled #then it dedupes, drops and sorts them', async () => {
    stubQueryLocalFonts(async () => [
      { family: 'Iosevka Term' },
      { family: 'Inter' },
      { family: 'Iosevka Term' },
      { family: ';;;' },
      { family: '   ' },
      { family: 'Avenir Next' }
    ])

    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() =>
      expect(result.current).toEqual({
        status: 'ready',
        families: ['Avenir Next', 'Inter', 'Iosevka Term']
      })
    )
  })

  it('#given StrictMode remounts the effect #when enabled #then it still resolves', async () => {
    stubQueryLocalFonts(async () => [{ family: 'Inter' }])

    const { result } = renderHook(() => useSystemFonts(true), { wrapper: StrictMode })

    await waitFor(() => expect(result.current).toEqual({ status: 'ready', families: ['Inter'] }))
  })

  it('#given a completed load #when enabled toggles again #then it does not query twice', async () => {
    const query = stubQueryLocalFonts(async () => [{ family: 'Inter' }])

    const { result, rerender } = renderHook(({ enabled }) => useSystemFonts(enabled), {
      initialProps: { enabled: true }
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ enabled: false })
    rerender({ enabled: true })

    expect(query).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ status: 'ready', families: ['Inter'] })
  })
})
