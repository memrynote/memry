/**
 * The undo-restore toast used to be an interpolated template literal
 * (`` `"${pending.title}" restored` ``), which the i18n lint gate could not see
 * (issue #1340). This pins it to a translation key and proves the item title is
 * still handed to the formatter as a placeholder value rather than pre-baked
 * into English prose.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { useUndoableAction } from './use-undoable-action'

// Typed off what the hook actually hands sonner, not off sonner's own signature.
// `ExternalToast['action']` is `ReactNode | Action`, and `Action.onClick` takes a
// React MouseEvent — reading the callback back off that union needs either an
// unsound cast or a fabricated synthetic event. The hook passes a zero-argument
// closure, which satisfies both shapes, so describing the call site directly keeps
// the read type-safe.
const mocks = vi.hoisted(() => ({
  toastSuccess:
    vi.fn<
      (message: string, options?: { action?: { label: string; onClick: () => void } }) => void
    >(),
  toastInfo: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: mocks.toastInfo
  })
}))

vi.mock('@memry/i18n/renderer', () => ({
  // Keyless calls render as the bare key; interpolated ones append their values
  // so the assertion can prove the caller passed them through.
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    archive: vi.fn().mockResolvedValue({ success: true }),
    undoArchive: vi.fn().mockResolvedValue({ success: true }),
    undoFile: vi.fn().mockResolvedValue({ success: true })
  }
}))

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useUndoableAction', () => {
  it('announces a restored item through a translation key, not hard-coded English', async () => {
    const { result } = renderHook(() => useUndoableAction(), { wrapper })

    await act(async () => {
      await result.current.archiveWithUndo('item-1', 'Saved Link')
    })

    const undoAction = mocks.toastSuccess.mock.calls[0]?.[1]?.action
    if (!undoAction) throw new Error('the archive toast did not offer an undo action')

    await act(async () => {
      undoAction.onClick()
    })

    expect(mocks.toastInfo).toHaveBeenCalledWith('toast.restored:{"title":"Saved Link"}')
  })
})
