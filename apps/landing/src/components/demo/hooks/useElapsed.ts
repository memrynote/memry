import { useState, useEffect, useRef } from 'react'

export function useElapsed(playing: boolean, duration: number) {
  const [elapsed, setElapsed] = useState(0)
  const rafRef = useRef<number>(0)
  const startRef = useRef<number | null>(null)
  const pausedAtRef = useRef(0)

  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafRef.current)
      pausedAtRef.current = elapsed
      startRef.current = null
      return
    }

    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now - pausedAtRef.current
      const ms = now - startRef.current
      setElapsed(Math.min(ms, duration))
      if (ms < duration) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, duration, elapsed])

  return elapsed
}
