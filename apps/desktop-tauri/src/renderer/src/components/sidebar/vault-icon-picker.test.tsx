import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const chunk = vi.hoisted(() => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  return { gate, release: () => release() }
})

// The picker's chunk arrives when the test says so, as a real one does a moment after the click.
vi.mock('@/components/note/note-title/EmojiPicker', async () => {
  await chunk.gate
  return { EmojiPicker: () => <div data-testid="emoji-picker" /> }
})

import { VaultIconPicker } from './vault-icon-picker'

function picker(): React.JSX.Element {
  return (
    <VaultIconPicker
      open
      onOpenChange={() => {}}
      vaultPath="/vaults/a"
      hasIcon={false}
      side="bottom"
    >
      <button type="button">glyph</button>
    </VaultIconPicker>
  )
}

describe('VaultIconPicker', () => {
  afterEach(cleanup)

  it('opens its popover once the picker is in, not around an empty box beforehand', async () => {
    render(picker())

    // #then the chunk is still loading: nothing is placed at the unshifted spot
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()

    // #when the chunk arrives
    await act(async () => chunk.release())

    // #then the popover opens around the picker itself
    expect(await screen.findByTestId('emoji-picker')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toContainElement(screen.getByTestId('emoji-picker'))
  })

  it('opens at once on a later open, the chunk being in', async () => {
    render(picker())
    await act(async () => chunk.release())
    cleanup()

    render(picker())

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('emoji-picker')).toBeInTheDocument()
  })
})
