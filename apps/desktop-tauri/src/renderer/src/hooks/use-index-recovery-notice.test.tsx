import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexRecoveredEvent } from '../../../preload/index.d'
import { useIndexRecoveryNotice } from './use-index-recovery-notice'

const toastFn = vi.fn()
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toastFn(...a) }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

let recoveredCb: ((event: IndexRecoveredEvent) => void) | null = null
const unsubscribe = vi.fn()

describe('useIndexRecoveryNotice', () => {
  beforeEach(() => {
    toastFn.mockClear()
    unsubscribe.mockClear()
    recoveredCb = null
    window.api = {
      onVaultIndexRecovered: vi.fn((cb: (event: IndexRecoveredEvent) => void) => {
        recoveredCb = cb
        return unsubscribe
      })
    } as never
  })

  it('says so, calmly, once the corrupt search index has been rebuilt', () => {
    renderHook(() => useIndexRecoveryNotice())

    // #when the main process reports it repaired the fts5 index by itself
    recoveredCb?.({ reason: 'fts_corrupt', filesIndexed: 42, duration: 1200 })

    // #then the user finally learns why search went quiet — instead of zero
    // results forever with no explanation
    expect(toastFn).toHaveBeenCalledWith('toast.searchIndexRepaired', {
      description: 'toast.searchIndexRepairedHint'
    })
  })

  it('stays quiet while a brand-new vault builds its first index', () => {
    renderHook(() => useIndexRecoveryNotice())

    // 'missing' is the ordinary first-open case: nothing was damaged, so there
    // is nothing to reassure anyone about.
    recoveredCb?.({ reason: 'missing', filesIndexed: 3, duration: 40 })

    expect(toastFn).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useIndexRecoveryNotice())
    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
