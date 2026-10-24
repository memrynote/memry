import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { blockNoteShadCNComponents } from './blocknote-shadcn-components'

const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } =
  blockNoteShadCNComponents.DropdownMenu!
const { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } =
  blockNoteShadCNComponents.Select!

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

describe('BlockNote select popup', () => {
  // #3400: inside the note's scroll container, opening the block-type dropdown
  // scrolled the whole note, because Base UI scrolls the item into view before
  // the popup is positioned.
  it('portals to document.body, outside the editor container, keeping the theme', () => {
    const container = document.createElement('div')
    container.className = 'bn-root light'
    container.setAttribute('data-color-scheme', 'dark')
    document.body.appendChild(container)

    render(
      <Select open value="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent container={container}>
          <SelectItem value="a">Heading 2</SelectItem>
        </SelectContent>
      </Select>
    )

    const popup = document.querySelector('[data-slot="select-content"]') as HTMLElement
    expect(container.contains(popup)).toBe(false)
    expect(document.body.contains(popup)).toBe(true)
    expect(popup.classList.contains('bn-root')).toBe(true)
    expect(popup.getAttribute('data-color-scheme')).toBe('dark')
    container.remove()
  })
})
