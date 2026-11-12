import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const chunk = vi.hoisted(() => ({
  /** What the picker's chunk does when asked for: fail, or never arrive. */
  mode: 'fail' as 'fail' | 'hang',
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: chunk.toastError, success: vi.fn() } }))

vi.mock('@/components/note/note-title/EmojiPicker', async () => {
  if (chunk.mode === 'hang') await new Promise(() => {})
  throw new Error('Failed to fetch dynamically imported module')
})

import { VaultIconPicker } from './vault-icon-picker'

function pickerElement(onOpenChange: (open: boolean) => void): ReactElement {
  return (
    <VaultIconPicker
      open
      onOpenChange={onOpenChange}
      vaultPath="/vaults/a"
      hasIcon={false}
      side="bottom"
    >
      <button type="button">glyph</button>
    </VaultIconPicker>
  )
}

function renderPicker(onOpenChange: (open: boolean) => void): RenderResult {
  return render(pickerElement(onOpenChange))
}

// The module mock is evaluated once per file and keeps its first outcome: the tests that need the
// chunk to fail come first.
describe('VaultIconPicker when its chunk does not load', () => {
  beforeEach(() => chunk.toastError.mockClear())
  afterEach(cleanup)

  it('closes with an error the user can see when the chunk fails to load', async () => {
    chunk.mode = 'fail'
    const onOpenChange = vi.fn()

    renderPicker(onOpenChange)
    await act(async () => {
      await Promise.resolve()
    })

    expect(chunk.toastError).toHaveBeenCalledTimes(1)
    // Its own message, not the one of a vault icon that failed to save.
    expect(chunk.toastError).toHaveBeenCalledWith('Could not load the icon picker')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not load the chunk again when a vault swipe re-renders it with a new onOpenChange', async () => {
    chunk.mode = 'fail'
    const view = renderPicker(vi.fn())
    await waitFor(() => expect(chunk.toastError).toHaveBeenCalledTimes(1))

    // The pill re-renders on every swipe step, with an inline onOpenChange each time.
    view.rerender(pickerElement(vi.fn()))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(chunk.toastError).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape while the chunk is still out, with nothing on screen to take it', async () => {
    chunk.mode = 'hang'
    const onOpenChange = vi.fn()

    renderPicker(onOpenChange)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('takes the Escape that closes it, so nothing behind it also goes back a level', () => {
    chunk.mode = 'hang'
    renderPicker(vi.fn())

    const notPrevented = fireEvent.keyDown(window, { key: 'Escape' })

    expect(notPrevented).toBe(false)
  })
})
