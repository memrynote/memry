import type { PointerEventHandler } from 'react'

interface ItemPointerProps {
  onPointerMove?: PointerEventHandler<HTMLDivElement>
  onPointerLeave?: PointerEventHandler<HTMLDivElement>
}

function preventWhileMenuCloses(
  handler: PointerEventHandler<HTMLDivElement> | undefined
): PointerEventHandler<HTMLDivElement> {
  return (event) => {
    handler?.(event)
    const menu = event.currentTarget.closest('[data-radix-menu-content]')
    if (menu?.getAttribute('data-state') === 'closed') event.preventDefault()
  }
}

/**
 * Radix keeps a chosen menu mounted for its exit animation, and its items keep
 * answering the pointer. A move focuses the item and a leave focuses the menu,
 * which takes focus from whatever the item just opened. A popover such as the
 * icon picker reads that as an outside interaction and closes (#2340). Radix
 * skips its own item handler for a default-prevented event, so this makes the
 * fading menu inert. The `data-[state=closed]:pointer-events-none` class on the
 * content cannot, because a modal menu's DismissableLayer holds an inline
 * `pointer-events: auto` there until it unmounts.
 */
export function inertWhileMenuCloses<P extends ItemPointerProps>(props: P): P {
  return {
    ...props,
    onPointerMove: preventWhileMenuCloses(props.onPointerMove),
    onPointerLeave: preventWhileMenuCloses(props.onPointerLeave)
  }
}
