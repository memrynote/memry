import * as React from 'react'

import { commands, events } from '../../../generated/bindings'
import { useCaptionButtonsVisible } from '@/lib/window-chrome'
import { subscribeToEvent } from '@/services/tauri-event'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:CaptionButtons')

type ButtonName = 'minimize' | 'maximize' | 'close'

/** Segoe Fluent Icons code points: minimize, maximize, restore, close. */
const GLYPH = { minimize: '\uE921', maximize: '\uE922', restore: '\uE923', close: '\uE8BB' }

interface ButtonProps {
  name: ButtonName
  glyph: string
  hover: ButtonName | null
  pressed: ButtonName | null
  buttonRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Not a `<button>`: Windows answers the pointer over these rectangles with a native hit-test
 * code (so the Windows 11 snap layouts appear), and the page gets no mouse events for them.
 * Hover and press arrive as shell events and show as data attributes.
 */
function CaptionButton({ name, glyph, hover, pressed, buttonRef }: ButtonProps): React.JSX.Element {
  return (
    <div
      ref={buttonRef}
      aria-hidden="true"
      data-caption-button={name}
      data-caption-hover={hover === name ? '' : undefined}
      data-caption-pressed={pressed === name ? '' : undefined}
      className={cn(
        'flex h-9 w-[46px] items-center justify-center text-[10px] leading-none text-foreground',
        'font-[Segoe_Fluent_Icons,Segoe_MDL2_Assets] select-none',
        name === 'close'
          ? 'data-[caption-hover]:bg-[#c42b1c] data-[caption-hover]:text-white data-[caption-pressed]:bg-[#c42b1c]/80 data-[caption-pressed]:text-white'
          : 'data-[caption-hover]:bg-foreground/10 data-[caption-pressed]:bg-foreground/20'
      )}
    >
      {glyph}
    </div>
  )
}

function rectOf(element: HTMLElement | null): {
  x: number
  y: number
  width: number
  height: number
} {
  const box = element?.getBoundingClientRect()
  const scale = window.devicePixelRatio
  return {
    x: (box?.x ?? 0) * scale,
    y: (box?.y ?? 0) * scale,
    width: (box?.width ?? 0) * scale,
    height: (box?.height ?? 0) * scale
  }
}

/** Minimize, maximize or restore, and close, drawn at the physical right edge in both directions. */
export function CaptionButtons(): React.JSX.Element | null {
  const visible = useCaptionButtonsVisible()
  const [hover, setHover] = React.useState<ButtonName | null>(null)
  const [pressed, setPressed] = React.useState<ButtonName | null>(null)
  const [maximized, setMaximized] = React.useState(false)
  const min = React.useRef<HTMLDivElement>(null)
  const max = React.useRef<HTMLDivElement>(null)
  const close = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!visible) return undefined
    const asName = (button: string | null): ButtonName | null =>
      button === 'minimize' || button === 'maximize' || button === 'close' ? button : null
    const stops = [
      subscribeToEvent(events.windowCaptionHoverChangedEvent, (e) => setHover(asName(e.button))),
      subscribeToEvent(events.windowCaptionPressedChangedEvent, (e) =>
        setPressed(asName(e.button))
      ),
      subscribeToEvent(events.windowChromeStateChangedEvent, (e) => setMaximized(e.maximized))
    ]
    return () => stops.forEach((stop) => stop())
  }, [visible])

  React.useEffect(() => {
    if (!visible) return undefined
    const report = (): void => {
      void commands
        .windowSetCaptionRects(rectOf(min.current), rectOf(max.current), rectOf(close.current))
        .catch(() => undefined)
    }
    report()
    const observer = new ResizeObserver(report)
    for (const element of [min.current, max.current, close.current]) {
      if (element) observer.observe(element)
    }
    observer.observe(document.documentElement)
    window.addEventListener('resize', report)
    // A display scale change moves every physical rectangle without resizing anything in CSS
    // pixels. The query matches one ratio, so it is armed again for the new one each time.
    let scale: MediaQueryList | null = null
    const onScale = (): void => {
      scale?.removeEventListener('change', onScale)
      scale = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      scale.addEventListener('change', onScale)
      report()
    }
    scale = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    scale.addEventListener('change', onScale)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      scale?.removeEventListener('change', onScale)
      // Hidden buttons (full screen) must not leave the native input sink over the page.
      const none = { x: 0, y: 0, width: 0, height: 0 }
      void commands
        .windowSetCaptionRects(none, none, none)
        .catch((error: unknown) => log.warn('caption rectangles not cleared', error))
    }
  }, [visible])

  if (!visible) return null
  return (
    <div className="fixed top-0 z-[80] flex h-9" style={{ direction: 'ltr', right: 0 }}>
      <CaptionButton
        name="minimize"
        glyph={GLYPH.minimize}
        hover={hover}
        pressed={pressed}
        buttonRef={min}
      />
      <CaptionButton
        name="maximize"
        glyph={maximized ? GLYPH.restore : GLYPH.maximize}
        hover={hover}
        pressed={pressed}
        buttonRef={max}
      />
      <CaptionButton
        name="close"
        glyph={GLYPH.close}
        hover={hover}
        pressed={pressed}
        buttonRef={close}
      />
    </div>
  )
}
