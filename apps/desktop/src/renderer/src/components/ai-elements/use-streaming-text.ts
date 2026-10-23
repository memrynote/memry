import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * AICSS Streaming Text cadence: 2 characters every 9ms.
 * Source: https://www.aicss.dev/components/streaming-text
 */
const CHARS_PER_MS = 2 / 9

/**
 * Backends deliver text in bursts (Codex hands over a whole message at once),
 * so a fixed cadence alone could fall seconds behind. The reveal speeds up so
 * any backlog drains within this window.
 */
const MAX_LAG_MS = 400

/**
 * Typewriter reveal over a growing string. Text present at mount is shown in
 * full, so reopening a conversation never re-types history; only characters
 * that arrive afterwards are revealed. Reduced motion shows everything at once.
 */
export function useStreamingText(text: string): { shown: string; typing: boolean } {
  const reducedMotion = useReducedMotion()
  const target = text.length
  const positionRef = useRef(target)
  const [length, setLength] = useState(target)

  useEffect(() => {
    if (reducedMotion) return
    positionRef.current = Math.min(positionRef.current, target)
    if (positionRef.current >= target) return

    let frame = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const elapsed = Math.max(0, now - last)
      last = now
      const backlog = target - positionRef.current
      const step = Math.max(elapsed * CHARS_PER_MS, (backlog * elapsed) / MAX_LAG_MS)
      positionRef.current = Math.min(target, positionRef.current + step)
      setLength(Math.floor(positionRef.current))
      if (positionRef.current < target) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, reducedMotion])

  if (reducedMotion) return { shown: text, typing: false }

  let end = Math.min(length, target)
  // Never split a surrogate pair: half an emoji renders as a replacement glyph.
  const previous = text.charCodeAt(end - 1)
  if (end < target && previous >= 0xd800 && previous <= 0xdbff) end += 1
  return { shown: text.slice(0, end), typing: end < target }
}
