import type { ComponentProps } from 'react'
import { ShadCNDefaultComponents, type ShadCNComponents } from '@blocknote/shadcn'

const ShadCNSubTrigger = ShadCNDefaultComponents.DropdownMenu.DropdownMenuSubTrigger
const ShadCNTrigger = ShadCNDefaultComponents.DropdownMenu.DropdownMenuTrigger

// Base UI closes a hover-opened submenu 40 ms after the pointer stops between
// its trigger and its popup. The tall Turn into submenu shifts up to fit a
// short window, so reaching it takes a long diagonal, and a brief hesitation on
// the way (a touchpad re-swipe) closed it under the pointer: the click landed
// on the editor and the block never changed, the symptom #3185 reports. The
// delay holds the close, and entering the submenu cancels it. 300 ms is the
// pointer grace of the Radix menus BlockNote used before 0.54.
const SUBMENU_CLOSE_DELAY_MS = 300

function DropdownMenuSubTrigger(props: ComponentProps<typeof ShadCNSubTrigger>): React.JSX.Element {
  return <ShadCNSubTrigger closeDelay={SUBMENU_CLOSE_DELAY_MS} {...props} />
}

type TriggerMouseEvent = React.MouseEvent & { preventBaseUIHandler?: () => void }

// Base UI opens a menu on mousedown, so pressing the block drag handle to drag
// it opened the block menu under the pointer. Skipping Base UI's press handlers
// leaves its click handler to open the menu: a click opens it, a drag never
// fires a click. Keyboard opening is untouched.
function skipPressOpen(event: TriggerMouseEvent): void {
  if (event.button === 0) event.preventBaseUIHandler?.()
}

function DropdownMenuTrigger(props: ComponentProps<typeof ShadCNTrigger>): React.JSX.Element {
  return <ShadCNTrigger onPointerDown={skipPressOpen} onMouseDown={skipPressOpen} {...props} />
}

const ShadCNSelectContent = ShadCNDefaultComponents.Select.SelectContent

/**
 * The stock Select popup portals into `editor.portalElement`, which sits inside
 * the note's scroll container. Base UI scrolls the selected item into view
 * before it has positioned the popup, so opening the block-type dropdown
 * scrolled the whole note (#3400). Portalling to `document.body` takes the popup
 * out of that container. Moving all of BlockNote's floating UI there instead
 * breaks the toolbar's placement, so only the Select moves, and it carries the
 * portal element's `bn-root` class and color scheme so the theme still applies.
 */
function SelectContent({
  container,
  className,
  ...props
}: ComponentProps<typeof ShadCNSelectContent>): React.JSX.Element {
  const portalElement = container instanceof HTMLElement ? container : undefined
  return (
    <ShadCNSelectContent
      {...props}
      container={document.body}
      className={[portalElement?.className, className].filter(Boolean).join(' ')}
      data-color-scheme={portalElement?.getAttribute('data-color-scheme') ?? undefined}
    />
  )
}

/** BlockNote's shadcn components with Memry's overrides, for editors that render menus. */
export const blockNoteShadCNComponents: Partial<ShadCNComponents> = {
  DropdownMenu: {
    ...ShadCNDefaultComponents.DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuSubTrigger
  },
  Select: { ...ShadCNDefaultComponents.Select, SelectContent }
}
