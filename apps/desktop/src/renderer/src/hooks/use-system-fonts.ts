import { useEffect, useRef, useState } from 'react'
import { sanitizeFontFamilyName } from '@/lib/interface-font'
import { createLogger } from '@/lib/logger'

const log = createLogger('SystemFonts')

declare global {
  interface Window {
    /**
     * Local Font Access API. Not in this project's TS lib, and only present in
     * Chromium behind the `local-fonts` permission the main process allows for
     * trusted app origins.
     */
    queryLocalFonts?: () => Promise<Array<{ family: string }>>
  }
}

export type SystemFontsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; families: string[] }
  | { status: 'unavailable' }

/**
 * The font families installed on this machine, enumerated the first time
 * `enabled` is true (the picker passes its open state) and kept afterwards.
 */
export function useSystemFonts(enabled: boolean): SystemFontsState {
  const [state, setState] = useState<SystemFontsState>({ status: 'idle' })
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true

    // Wrapped in an async IIFE, rather than calling `setState` directly in the
    // effect body, so this reads as the async operation it is: enumerating
    // fonts is a real side effect, not state derived from the `enabled` prop.
    void (async () => {
      if (typeof window.queryLocalFonts !== 'function') {
        setState({ status: 'unavailable' })
        return
      }

      setState({ status: 'loading' })

      // No cancel-on-cleanup guard: StrictMode tears the first effect down and
      // the `started` ref makes the remount a no-op, so cancelling here would
      // strand the state on `loading` forever.
      try {
        const fonts = await window.queryLocalFonts()
        // FontData keeps `family` on its prototype, so read the accessor per
        // face rather than copying or spreading the object.
        const families = [
          ...new Set(fonts.map((font) => sanitizeFontFamilyName(font.family)).filter(Boolean))
        ].sort((a, b) => a.localeCompare(b))
        setState(families.length > 0 ? { status: 'ready', families } : { status: 'unavailable' })
      } catch (error) {
        log.warn('Failed to enumerate local fonts', error)
        setState({ status: 'unavailable' })
      }
    })()
  }, [enabled])

  return state
}
