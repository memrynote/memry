import type { ComponentProps } from 'react'
import { ShadCNDefaultComponents, type ShadCNComponents } from '@blocknote/shadcn'

const ShadCNSubTrigger = ShadCNDefaultComponents.DropdownMenu.DropdownMenuSubTrigger

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

/** BlockNote's shadcn components with Memry's overrides, for editors that render menus. */
export const blockNoteShadCNComponents: Partial<ShadCNComponents> = {
  DropdownMenu: { ...ShadCNDefaultComponents.DropdownMenu, DropdownMenuSubTrigger }
}
