import type { ComponentProps } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ShadCNDefaultComponents, type ShadCNComponents } from '@blocknote/shadcn'
import { cn } from './utils'

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

type MenuContentProps = ComponentProps<
  typeof ShadCNDefaultComponents.DropdownMenu.DropdownMenuContent
>

/**
 * BlockNote's shadcn menu content with `positionMethod="fixed"`. Base UI renders
 * a menu `fixed` until its first placement but computes that placement with the
 * positioner's method, `absolute` by default. Measured while fixed, the first
 * placement comes out in viewport coordinates, and BlockNote portals menus into
 * `editor.portalElement` inside the offset `.bn-container`, so the first
 * positioned frame drew the menu one container offset away (404 px in the side
 * menu's Turn into submenu) until autoUpdate corrected it. A click in that gap
 * hit the editor and changed nothing (#3967, #4213). Fixed keeps the measured
 * and the rendered strategy the same. A fixed menu is not clipped by the note's
 * scroll container, so the container's clipping ancestors stay its collision
 * boundary and the menu opens where the absolute one did. The markup is
 * shadcn's `dropdown-menu`, which forwards no positioner props.
 */
function DropdownMenuContent({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  className,
  container,
  ...props
}: MenuContentProps): React.JSX.Element {
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        positionMethod="fixed"
        collisionBoundary={clippingAncestors(container)}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95',
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** The ancestors from `container` up that clip overflow, as they clip an absolute menu inside it. */
function clippingAncestors(
  container: MenuContentProps['container']
): Element[] | 'clipping-ancestors' {
  const clipping: Element[] = []
  for (
    let node = container instanceof Element ? container : null;
    node;
    node = node.parentElement
  ) {
    const { overflowX, overflowY } = getComputedStyle(node)
    if (/auto|scroll|hidden|clip/.test(`${overflowX} ${overflowY}`)) clipping.push(node)
  }
  return clipping.length > 0 ? clipping : 'clipping-ancestors'
}

function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  className,
  ...props
}: MenuContentProps): React.JSX.Element {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'w-auto min-w-[96px] rounded-md bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        className
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
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
    DropdownMenuSubTrigger,
    DropdownMenuContent,
    DropdownMenuSubContent
  },
  Select: { ...ShadCNDefaultComponents.Select, SelectContent }
}
