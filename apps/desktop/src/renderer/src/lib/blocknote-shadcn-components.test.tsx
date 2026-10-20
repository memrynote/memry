import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { blockNoteShadCNComponents } from './blocknote-shadcn-components'

const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } =
  blockNoteShadCNComponents.DropdownMenu!

function renderMenu() {
  render(
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<button type="button">handle</button>} />
      <DropdownMenuContent>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return screen.getByRole('button', { name: 'handle' })
}

async function flushFrames() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
}

describe('BlockNote dropdown trigger', () => {
  it('stays closed while the handle is held down to drag', async () => {
    const trigger = renderMenu()
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(trigger, { button: 0 })
    await flushFrames()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('opens on a click', async () => {
    const trigger = renderMenu()
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(trigger, { button: 0 })
    fireEvent.mouseUp(trigger, { button: 0 })
    fireEvent.click(trigger, { button: 0 })
    await flushFrames()
    expect(screen.getByText('Delete')).toBeTruthy()
  })
})
