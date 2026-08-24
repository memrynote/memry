/**
 * The reveal action is cross-platform; its wording is not. These pin the
 * mapping so a Windows or Linux build never ships the word "Finder".
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getFileManagerPlatform, useFileActionLabels } from './use-file-action-labels'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const originalPlatform = navigator.platform

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
    enumerable: true
  })
}

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('getFileManagerPlatform', () => {
  it.each([
    ['MacIntel', 'mac'],
    ['macOS', 'mac'],
    ['Win32', 'windows'],
    ['Windows', 'windows'],
    ['Linux x86_64', 'linux'],
    ['FreeBSD', 'linux'],
    ['', 'linux']
  ])('maps %s to %s', (platform, expected) => {
    setPlatform(platform)
    expect(getFileManagerPlatform()).toBe(expected)
  })
})

describe('useFileActionLabels', () => {
  beforeEach(() => {
    setPlatform('MacIntel')
  })

  it('uses the Finder wording on macOS', () => {
    const { result } = renderHook(() => useFileActionLabels())
    expect(result.current.revealInFolder).toBe('fileActions.revealInFinder')
  })

  it('uses the Explorer wording on Windows', () => {
    setPlatform('Win32')
    const { result } = renderHook(() => useFileActionLabels())
    expect(result.current.revealInFolder).toBe('fileActions.showInExplorer')
  })

  it('falls back to the generic file-manager wording elsewhere', () => {
    setPlatform('Linux x86_64')
    const { result } = renderHook(() => useFileActionLabels())
    expect(result.current.revealInFolder).toBe('fileActions.showInFileManager')
  })

  it('keeps one platform-neutral label for the default-app action', () => {
    const { result } = renderHook(() => useFileActionLabels())
    expect(result.current.openInDefaultApp).toBe('fileActions.openInDefaultApp')
  })
})
