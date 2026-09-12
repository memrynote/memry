/**
 * The reduced-motion flag as the guest's SCRIPTS see it.
 *
 * `main.ts` writes the host's `cfg.reducedMotion` onto the root element as a
 * class, and `styles.css` keys its animation/transition override off the same
 * class. Anything that animates from JavaScript has to read the class too —
 * a `behavior: 'smooth'` scroll is motion the stylesheet cannot reach.
 */
export function isReducedMotion(): boolean {
  return document.documentElement.classList.contains('reduced-motion')
}

/** `auto` when the reader asked for less motion, `smooth` otherwise. */
export function scrollBehavior(): ScrollBehavior {
  return isReducedMotion() ? 'auto' : 'smooth'
}
