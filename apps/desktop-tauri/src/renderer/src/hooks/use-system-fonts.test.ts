import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSystemFonts } from './use-system-fonts'

const systemFontsList = vi.hoisted(() => vi.fn<() => Promise<string[]>>())

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../../generated/bindings', () => ({ commands: { systemFontsList } }))

beforeEach(() => {
  systemFontsList.mockReset()
})

describe('useSystemFonts', () => {
  it('#given it is disabled #when rendered #then it never asks the system', () => {
    systemFontsList.mockResolvedValue(['Inter'])

    const { result } = renderHook(() => useSystemFonts(false))

    expect(result.current).toEqual({ status: 'idle' })
    expect(systemFontsList).not.toHaveBeenCalled()
  })

  it('#given the command fails #when enabled #then it reports unavailable', async () => {
    systemFontsList.mockRejectedValue(new Error('no fonts'))

    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }))
  })

  it('#given no families come back #when enabled #then it reports unavailable', async () => {
    systemFontsList.mockResolvedValue([])

    const { result } = renderHook(() => useSystemFonts(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }))
  })

  it('#given repeated and unusable families #when enabled #then it dedupes, drops and sorts them', async () => {
    systemFontsList.mockResolvedValue([
      'Iosevka Term',
      'Inter',
      'Iosevka Term',
      ';;;',
      '   ',
      'Avenir Next'
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
    systemFontsList.mockResolvedValue(['Inter'])

    const { result } = renderHook(() => useSystemFonts(true), { wrapper: StrictMode })

    await waitFor(() => expect(result.current).toEqual({ status: 'ready', families: ['Inter'] }))
  })

  it('#given a completed load #when enabled toggles again #then it does not ask twice', async () => {
    systemFontsList.mockResolvedValue(['Inter'])

    const { result, rerender } = renderHook(({ enabled }) => useSystemFonts(enabled), {
      initialProps: { enabled: true }
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ enabled: false })
    rerender({ enabled: true })

    expect(systemFontsList).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ status: 'ready', families: ['Inter'] })
  })
})
