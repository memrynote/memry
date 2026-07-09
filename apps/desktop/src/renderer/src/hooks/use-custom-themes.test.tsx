import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCustomThemes } from './use-custom-themes'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  createdListeners: [] as Array<(event: { id: string }) => void>,
  updatedListeners: [] as Array<(event: { id: string }) => void>,
  deletedListeners: [] as Array<(event: { id: string }) => void>
}))

vi.mock('@/services/themes-service', () => ({
  themesService: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.remove
  },
  onThemeCreated: (callback: (event: { id: string }) => void) => {
    mocks.createdListeners.push(callback)
    return vi.fn()
  },
  onThemeUpdated: (callback: (event: { id: string }) => void) => {
    mocks.updatedListeners.push(callback)
    return vi.fn()
  },
  onThemeDeleted: (callback: (event: { id: string }) => void) => {
    mocks.deletedListeners.push(callback)
    return vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const theme = {
  id: 'theme-1',
  name: 'Tema 1',
  base: 'dark' as const,
  variables: { '--background': '#101010' },
  createdAt: '2026-07-09T10:00:00.000Z',
  modifiedAt: '2026-07-09T10:00:00.000Z'
}

describe('useCustomThemes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createdListeners = []
    mocks.updatedListeners = []
    mocks.deletedListeners = []
    mocks.list.mockResolvedValue([theme])
  })

  it('loads themes and reloads on change events', async () => {
    const { result } = renderHook(() => useCustomThemes())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.themes).toEqual([theme])

    mocks.list.mockResolvedValueOnce([{ ...theme, name: 'Renamed' }])
    await act(async () => {
      mocks.updatedListeners[0]({ id: 'theme-1' })
    })
    await waitFor(() => expect(result.current.themes[0].name).toBe('Renamed'))
  })

  it('createTheme returns the created theme on success and null on failure', async () => {
    const { result } = renderHook(() => useCustomThemes())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    mocks.create.mockResolvedValueOnce({ success: true, theme })
    await expect(result.current.createTheme({ name: 'Tema 1', base: 'dark' })).resolves.toEqual(
      theme
    )

    mocks.create.mockResolvedValueOnce({ success: false, error: 'nope' })
    await expect(result.current.createTheme({ name: 'X', base: 'light' })).resolves.toBeNull()

    mocks.create.mockRejectedValueOnce(new Error('ipc down'))
    await expect(result.current.createTheme({ name: 'Y', base: 'white' })).resolves.toBeNull()
  })

  it('updateTheme forwards id + updates and tolerates failures', async () => {
    const { result } = renderHook(() => useCustomThemes())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    mocks.update.mockResolvedValueOnce({ success: true, theme })
    await expect(result.current.updateTheme('theme-1', { name: 'New' })).resolves.toEqual(theme)
    expect(mocks.update).toHaveBeenCalledWith({ id: 'theme-1', name: 'New' })

    mocks.update.mockRejectedValueOnce(new Error('ipc down'))
    await expect(result.current.updateTheme('theme-1', {})).resolves.toBeNull()
  })

  it('deleteTheme returns the success flag and false on transport errors', async () => {
    const { result } = renderHook(() => useCustomThemes())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    mocks.remove.mockResolvedValueOnce({ success: true })
    await expect(result.current.deleteTheme('theme-1')).resolves.toBe(true)

    mocks.remove.mockRejectedValueOnce(new Error('ipc down'))
    await expect(result.current.deleteTheme('theme-1')).resolves.toBe(false)
  })
})
