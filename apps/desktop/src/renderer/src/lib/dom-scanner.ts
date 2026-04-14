const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-hint]'
].join(', ')

const HINT_OVERLAY_ID = 'hint-mode-overlay'

const MIN_SIZE = 8

const isVisible = (el: HTMLElement): boolean => {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false
  if (getComputedStyle(el).pointerEvents === 'none') return false
  return true
}

const isInViewport = (rect: DOMRect): boolean => {
  return (
    rect.width >= MIN_SIZE &&
    rect.height >= MIN_SIZE &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

const isEnabled = (el: HTMLElement): boolean => {
  if (el.hasAttribute('disabled')) return false
  if (el.getAttribute('aria-disabled') === 'true') return false
  return true
}

const isInsideOverlay = (el: HTMLElement): boolean => {
  const overlay = document.getElementById(HINT_OVERLAY_ID)
  return overlay !== null && overlay.contains(el)
}

export const scanClickableElements = (): HTMLElement[] => {
  const candidates = document.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR)
  const results: HTMLElement[] = []

  for (const el of candidates) {
    if (!isEnabled(el)) continue
    if (isInsideOverlay(el)) continue
    if (!isVisible(el)) continue
    const rect = el.getBoundingClientRect()
    if (!isInViewport(rect)) continue
    results.push(el)
  }

  return results
}

export { HINT_OVERLAY_ID }
