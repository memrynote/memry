import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { blockNoteShadCNComponents } from './blocknote-shadcn-components'

const {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} = blockNoteShadCNComponents.DropdownMenu!
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

describe('BlockNote menu placement', () => {
  // #3967: Base UI drew a menu `fixed` before its first placement, measured it
  // so, then applied the result as `absolute` inside BlockNote's offset portal
  // container: the first positioned frame sat one container offset away.
  it('positions the menu and its submenu with the strategy they render with before placement', async () => {
    const positions = new Map<Element, Set<string>>()
    const record = (): void => {
      for (const positioner of document.querySelectorAll('[role="presentation"]')) {
        const position = (positioner as HTMLElement).style.position
        if (!position) continue
        positions.set(positioner, (positions.get(positioner) ?? new Set()).add(position))
      }
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })

    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger render={<button type="button">handle</button>} />
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Turn into</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Heading 1</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    await flushFrames()
    record()
    observer.disconnect()

    expect(screen.getByText('Heading 1')).toBeTruthy()
    expect([...positions.values()].map((seen) => [...seen])).toEqual([['fixed'], ['fixed']])
  })

  // #4227: a fixed menu is not clipped by the note's scroll container, so with the note scrolling
  // under an open menu it followed its anchor over the tab bar. The absolute menu was clipped away.
  it('hides the menu and its submenu while the anchor is scrolled out of the note', async () => {
    await withScrolledNote(async (note) => {
      expect(note.invisible()).toEqual([false, false])

      await note.scrollAnchorOut()
      expect(note.invisible()).toEqual([true, true])

      // Back in view, the menu that stayed open shows again.
      await note.scrollAnchorIn()
      expect(note.invisible()).toEqual([false, false])
    })
  })
})

type ScrolledNote = {
  invisible: () => boolean[]
  scrollAnchorOut: () => Promise<void>
  scrollAnchorIn: () => Promise<void>
}

/** An open block menu and its Turn into submenu, portalled into a note scrolled under a tab bar. */
async function withScrolledNote(run: (note: ScrolledNote) => Promise<void>): Promise<void> {
  const rects = new Map<Element, DOMRect>()
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    return rects.get(this) ?? new DOMRect(0, 0, 0, 0)
  })
  const size = (el: Element, width: number, height: number): void => {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  }
  // The note's scroll container below a 100 px tab bar, the editor's portal element inside it.
  const scroller = document.createElement('div')
  try {
    size(document.documentElement, 1000, 800)
    scroller.style.overflow = 'auto'
    const host = document.createElement('div')
    const portal = document.createElement('div')
    scroller.append(host, portal)
    document.body.appendChild(scroller)
    rects.set(scroller, new DOMRect(0, 100, 600, 500))
    size(scroller, 600, 500)

    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger render={<button type="button">handle</button>} />
        <DropdownMenuContent container={portal}>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Turn into</DropdownMenuSubTrigger>
            <DropdownMenuSubContent container={portal}>
              <DropdownMenuItem>Heading 1</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
      { container: host }
    )
    await flushFrames()
    const handle = screen.getByRole('button', { name: 'handle' })
    rects.set(screen.getByText('Turn into'), new DOMRect(40, 230, 120, 28))
    const scrollTo = async (handleTop: number): Promise<void> => {
      rects.set(handle, new DOMRect(20, handleTop, 18, 24))
      scroller.dispatchEvent(new Event('scroll'))
      await flushFrames()
    }
    await scrollTo(200)

    await run({
      invisible: () =>
        [...portal.querySelectorAll('[role="menu"]')].map(
          (menu) => getComputedStyle(menu.parentElement!).visibility === 'hidden'
        ),
      // The note scrolls the handle up past the container's top edge, under the tab bar.
      scrollAnchorOut: () => scrollTo(40),
      scrollAnchorIn: () => scrollTo(200)
    })
  } finally {
    rectSpy.mockRestore()
    delete (document.documentElement as Partial<HTMLElement>).clientWidth
    delete (document.documentElement as Partial<HTMLElement>).clientHeight
    scroller.remove()
  }
}

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
