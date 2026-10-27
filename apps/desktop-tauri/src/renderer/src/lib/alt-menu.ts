import { useEffect } from 'react'

import { commands } from '../../../generated/bindings'

/** Windows and Linux have no menu bar showing: a bare Alt opens it (`menu_toggle_alt`). */
const MENU_PLATFORMS = new Set(['win32', 'linux'])

export interface AltMenuHost {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void
}

interface KeyLike {
  key: string
  repeat?: boolean
}

function keyOf(event: Event): KeyLike {
  return event instanceof KeyboardEvent ? event : { key: '' }
}

/**
 * Tells a bare Alt (pressed and released with nothing between) from an Alt chord, and reports
 * it. Escape or a blur ends a Linux menu bar the shell is showing. Returns the cleanup.
 */
export function watchAltMenu(
  host: AltMenuHost,
  report: { toggle: () => Promise<boolean>; hide: () => Promise<unknown> }
): () => void {
  let altDown = false
  let chord = false
  let barShown = false

  const onKeyDown = (raw: Event): void => {
    const event = keyOf(raw)
    if (event.key === 'Alt') {
      if (!event.repeat) {
        altDown = true
        chord = false
      }
      return
    }
    if (altDown) chord = true
    if (event.key === 'Escape' && barShown) {
      barShown = false
      void report.hide().catch(() => undefined)
    }
  }
  const onKeyUp = (raw: Event): void => {
    const event = keyOf(raw)
    if (event.key !== 'Alt') return
    const bare = altDown && !chord
    altDown = false
    if (!bare) return
    void report
      .toggle()
      .then((shown) => {
        barShown = shown
      })
      .catch(() => undefined)
  }
  const cancel = (): void => {
    if (altDown) chord = true
  }
  const onBlur = (): void => {
    altDown = false
    barShown = false
  }

  host.addEventListener('keydown', onKeyDown, true)
  host.addEventListener('keyup', onKeyUp, true)
  host.addEventListener('mousedown', cancel, true)
  host.addEventListener('blur', onBlur)
  return () => {
    host.removeEventListener('keydown', onKeyDown, true)
    host.removeEventListener('keyup', onKeyUp, true)
    host.removeEventListener('mousedown', cancel, true)
    host.removeEventListener('blur', onBlur)
  }
}

export function useAltMenuToggle(): void {
  useEffect(() => {
    const platform = document.documentElement.getAttribute('data-platform') ?? ''
    if (!MENU_PLATFORMS.has(platform)) return undefined
    return watchAltMenu(window, {
      toggle: () => commands.menuToggleAlt(),
      hide: () => commands.menuHideAlt()
    })
  }, [])
}
