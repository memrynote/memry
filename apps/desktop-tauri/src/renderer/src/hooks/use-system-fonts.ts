import { useEffect, useRef, useState } from 'react'
import { commands } from '../../../generated/bindings'
import { sanitizeFontFamilyName } from '@/lib/interface-font'
import { createLogger } from '@/lib/logger'

const log = createLogger('SystemFonts')

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
      setState({ status: 'loading' })

      // No cancel-on-cleanup guard: StrictMode tears the first effect down and
      // the `started` ref makes the remount a no-op, so cancelling here would
      // strand the state on `loading` forever.
      try {
        const families = [
          ...new Set((await commands.systemFontsList()).map(sanitizeFontFamilyName).filter(Boolean))
        ].toSorted((a, b) => a.localeCompare(b))
        setState(families.length > 0 ? { status: 'ready', families } : { status: 'unavailable' })
      } catch (error) {
        log.warn('Failed to enumerate local fonts', error)
        setState({ status: 'unavailable' })
      }
    })()
  }, [enabled])

  return state
}
