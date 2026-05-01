import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePropertiesCollapsed } from './use-properties-collapsed'

describe('usePropertiesCollapsed', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns false (expanded) when no key is stored', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    expect(result.current[0]).toBe(false)
  })

  it('returns true (collapsed) when localStorage holds "1" for the noteId', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    expect(result.current[0]).toBe(true)
  })

  it('toggle() flips expanded → collapsed and writes "1"', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[1]()
    })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBe('1')
  })

  it('toggle() flips collapsed → expanded and removes the key', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[1]()
    })
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBeNull()
  })

  it('setCollapsed(true) writes "1"', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](true)
    })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBe('1')
  })

  it('setCollapsed(false) removes the key', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](false)
    })
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBeNull()
  })

  it('different noteIds keep state isolated', () => {
    localStorage.setItem('memry:properties-collapsed:note-A', '1')
    const { result: resultA } = renderHook(() => usePropertiesCollapsed('note-A'))
    const { result: resultB } = renderHook(() => usePropertiesCollapsed('note-B'))
    expect(resultA.current[0]).toBe(true)
    expect(resultB.current[0]).toBe(false)
  })

  it('returns expanded with no-op handlers when noteId is empty', () => {
    const { result } = renderHook(() => usePropertiesCollapsed(''))
    expect(result.current[0]).toBe(false)
    act(() => {
      result.current[1]()
      result.current[2](true)
    })
    expect(localStorage.length).toBe(0)
  })

  it('catches QuotaExceededError on setItem and falls back to in-memory state', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](true)
    })
    expect(result.current[0]).toBe(true)
    setItemSpy.mockRestore()
  })

  it('catches errors on removeItem and falls back to in-memory state', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('removal failed')
    })
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](false)
    })
    expect(result.current[0]).toBe(false)
    removeItemSpy.mockRestore()
  })
})
