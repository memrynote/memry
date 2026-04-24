import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'

import { useSaveFilterShortcut } from './use-save-filter-shortcut'

describe('useSaveFilterShortcut', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls onSave when Cmd+S is pressed and filters are active', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true }))

    fireEvent.keyDown(document, { key: 's', metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('calls onSave when Ctrl+S is pressed and filters are active', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true }))

    fireEvent.keyDown(document, { key: 's', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onSave when filters are not active', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: false }))

    fireEvent.keyDown(document, { key: 's', metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does NOT call onSave when just S is pressed (no modifier)', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true }))

    fireEvent.keyDown(document, { key: 's' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('prevents default browser save behavior', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true }))

    const event = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    document.dispatchEvent(event)

    expect(preventSpy).toHaveBeenCalled()
  })

  it('cleans up listener on unmount', () => {
    const onSave = vi.fn()
    const { unmount } = renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true }))

    unmount()
    fireEvent.keyDown(document, { key: 's', metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does NOT fire when disabled is true', () => {
    const onSave = vi.fn()
    renderHook(() => useSaveFilterShortcut({ onSave, hasActiveFilters: true, disabled: true }))

    fireEvent.keyDown(document, { key: 's', metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })
})
