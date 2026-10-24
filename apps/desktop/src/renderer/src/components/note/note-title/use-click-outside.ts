import type { RefObject } from 'react'
import { useEffect } from 'react'

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: (event: MouseEvent | TouchEvent) => void,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return undefined

    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DOM event targets are typed EventTarget; this handler is bound to elements, so the target is the Element/Node
      if (!el || el.contains(event.target as Node)) {
        return
      }
      handler(event)
    }

    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)

    return () => {
      document.removeEventListener('mousedown', listener)
      document.removeEventListener('touchstart', listener)
    }
  }, [ref, handler, enabled])
}
