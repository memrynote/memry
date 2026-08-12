/**
 * Resolves Tailwind's hover-reveal idiom for jsdom.
 *
 * The sidebar hides row actions with `opacity-0` plus a
 * `group-hover/<name>:opacity-100` variant. jsdom loads no stylesheet, so
 * `getComputedStyle` reports the same empty opacity for a control that is on
 * screen and one that is not — a test that asked the DOM would pass whether or
 * not the reveal exists. This walks the class list instead and resolves each
 * opacity variant against the LIVE DOM, so a test can put real keyboard focus
 * somewhere and ask whether the control is visible.
 *
 * `hover` never holds: jsdom has no pointer, so `:hover` matches nothing. That
 * is the point — these tests are about the keyboard, and a control that is only
 * reachable by hover must read as hidden here.
 *
 * An unrecognised variant throws instead of being skipped. A helper that
 * quietly ignored the class carrying the fix would report "hidden" forever and
 * every test using it would pass for the wrong reason.
 *
 * @module tests/utils/reveal
 */

/** `opacity-0`, `group-hover/section:opacity-100`, `md:opacity-0`, ... */
const OPACITY_CLASS = /^(?:(.+):)?opacity-(\d{1,3})$/

/** `group-hover/section`, `group-focus-within`, `group-focus/menu-item` */
const GROUP_VARIANT = /^group-(hover|focus|focus-within|focus-visible)(?:\/(.+))?$/

/** `data-[state=open]` */
const DATA_VARIANT = /^data-\[([^\]=]+)=([^\]]+)\]$/

/** The `md:` breakpoint, resolved against the jsdom viewport. */
const MD_MIN_WIDTH = 768

function classesOf(element: Element): string[] {
  // SVG elements expose `className` as an SVGAnimatedString, so read the
  // attribute — the chevron in a section header is an <svg>.
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

/**
 * `:focus-within` and `:focus-visible` are spelled out rather than handed to
 * `matches()`: jsdom's selector engine has no focus-visible heuristic, and
 * "contains the active element" is the whole definition of focus-within.
 */
function holdsFocusState(node: Element, state: string): boolean {
  const active = node.ownerDocument.activeElement
  if (!active) return false
  if (state === 'focus-within') return node.contains(active)
  // Keyboard focus is exactly the case `focus-visible` exists to cover, and the
  // only kind of focus these tests produce.
  return node === active
}

function variantHolds(variant: string, element: Element): boolean {
  if (variant === 'md') return element.ownerDocument.defaultView!.innerWidth >= MD_MIN_WIDTH
  if (variant === 'hover') return false

  const group = GROUP_VARIANT.exec(variant)
  if (group) {
    const [, state, name] = group
    if (state === 'hover') return false
    const ancestor = element.closest(name ? `.group\\/${name}` : '.group')
    return ancestor !== null && holdsFocusState(ancestor, state)
  }

  if (variant === 'focus' || variant === 'focus-within' || variant === 'focus-visible') {
    return holdsFocusState(element, variant)
  }

  const data = DATA_VARIANT.exec(variant)
  if (data) return element.getAttribute(`data-${data[1]}`) === data[2]

  throw new Error(
    `tests/utils/reveal: unsupported Tailwind variant "${variant}". Teach the helper about it — ` +
      'silently ignoring it would make the assertion meaningless.'
  )
}

/**
 * The opacity the element would paint at, given where focus currently is.
 * Unvariated classes are applied first so class order in the source cannot
 * decide the answer.
 */
export function revealedOpacity(element: Element): number {
  const parsed = classesOf(element)
    .map((cls) => OPACITY_CLASS.exec(cls))
    .filter((match): match is RegExpExecArray => match !== null)

  let opacity = 100
  for (const [, variants, value] of parsed) {
    if (!variants) opacity = Number(value)
  }
  for (const [, variants, value] of parsed) {
    if (variants && variants.split(':').every((variant) => variantHolds(variant, element))) {
      opacity = Number(value)
    }
  }
  return opacity
}

/** True when the element is on screen for a user who navigated here by keyboard. */
export function isRevealed(element: Element): boolean {
  return revealedOpacity(element) > 0
}
