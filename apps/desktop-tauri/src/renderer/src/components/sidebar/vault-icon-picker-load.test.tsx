import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

function renderPicker(onOpenChange: (open: boolean) => void): void {
  render(
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
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on Escape while the chunk is still out, with nothing on screen to take it', async () => {
    chunk.mode = 'hang'
    const onOpenChange = vi.fn()

    renderPicker(onOpenChange)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
