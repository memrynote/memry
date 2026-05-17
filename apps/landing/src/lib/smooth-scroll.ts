import type Lenis from 'lenis'

type LenisTarget = Parameters<Lenis['scrollTo']>[0]
type LenisScrollOptions = NonNullable<Parameters<Lenis['scrollTo']>[1]>

const HEADER_SCROLL_OFFSET = -96

let landingLenis: Lenis | null = null

export const LANDING_ANCHOR_SCROLL_OPTIONS = {
  offset: HEADER_SCROLL_OFFSET,
  duration: 1.05,
  easing: (time: number) => Math.min(1, 1.001 - 2 ** (-10 * time))
} satisfies LenisScrollOptions

export function setLandingLenis(lenis: Lenis | null) {
  landingLenis = lenis
}

export function prefersReducedLandingMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function scrollToLandingTarget(target: LenisTarget, options: LenisScrollOptions = {}) {
  const scrollOptions = { ...LANDING_ANCHOR_SCROLL_OPTIONS, ...options }

  if (landingLenis && !prefersReducedLandingMotion()) {
    landingLenis.scrollTo(target, scrollOptions)
    return
  }

  scrollNatively(target, scrollOptions)
}

function scrollNatively(target: LenisTarget, options: LenisScrollOptions) {
  if (typeof window === 'undefined') return

  const behavior = prefersReducedLandingMotion() || options.immediate ? 'auto' : 'smooth'
  const offset = options.offset ?? 0

  if (typeof target === 'number') {
    window.scrollTo({ top: Math.max(0, target + offset), behavior })
    return
  }

  if (typeof target === 'string') {
    if (target === 'top' || target === 'start' || target === 'left') {
      window.scrollTo({ top: 0, left: 0, behavior })
      return
    }

    if (target === 'bottom' || target === 'end' || target === 'right') {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior
      })
      return
    }

    const element = getElementTarget(target)
    if (element) {
      scrollElementNatively(element, offset, behavior)
    }
    return
  }

  scrollElementNatively(target, offset, behavior)
}

function getElementTarget(selector: string) {
  try {
    const element = document.querySelector(selector)
    if (element instanceof HTMLElement) return element
  } catch {
    // Fall through to id lookup for simple hash values.
  }

  const id = selector.startsWith('#') ? selector.slice(1) : selector
  return document.getElementById(id)
}

function scrollElementNatively(element: HTMLElement, offset: number, behavior: ScrollBehavior) {
  const top = element.getBoundingClientRect().top + window.scrollY + offset
  window.scrollTo({ top: Math.max(0, top), behavior })
}
