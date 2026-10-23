import { useEffect, useSyncExternalStore } from 'react'

/**
 * Window Controls Overlay (Windows only, main/title-bar-overlay.ts): the native
 * caption buttons are drawn over the top-end corner of the title row. Layout
 * reserves their width in CSS through `env(titlebar-area-*)` (main.css); this
 * module covers what CSS cannot.
 *
 * lib.dom does not type the API yet, so the slice used here is declared locally.
 */
interface WindowControlsOverlayLike extends EventTarget {
  readonly visible: boolean
}

function getOverlay(): WindowControlsOverlayLike | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
}

function subscribe(onChange: () => void): () => void {
  const overlay = getOverlay()
  overlay?.addEventListener('geometrychange', onChange)
  return () => overlay?.removeEventListener('geometrychange', onChange)
}

const isVisible = (): boolean => getOverlay()?.visible === true

/** True while caption buttons cover the title row (false on macOS, Linux, and in fullscreen). */
export function useWindowControlsOverlayVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible, () => false)
}

/**
 * Resolves any CSS color (oklch, color-mix, var-derived) to #rrggbb by painting
 * one pixel. Electron's color parser only takes sRGB formats.
 */
function toHexColor(cssColor: string, ctx: CanvasRenderingContext2D): string | null {
  // An unparseable value leaves fillStyle at its previous color instead of throwing.
  if (!cssColor || !CSS.supports('color', cssColor)) return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = cssColor
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === 0) return null
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Keeps the caption-button glyphs in the theme's foreground color. Theme mode,
 * color theme and custom colors all land on <html> as a class or inline style,
 * so one observer there covers every way the palette changes.
 */
export function useTitleBarSymbolColorSync(): void {
  useEffect(() => {
    if (!getOverlay()) return
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const root = document.documentElement
    let lastSent: string | null = null

    const sync = (): void => {
      const color = toHexColor(getComputedStyle(root).getPropertyValue('--foreground').trim(), ctx)
      if (!color || color === lastSent) return
      lastSent = color
      window.api.setTitleBarSymbolColor(color)
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [])
}
