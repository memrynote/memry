import { useCallback, useEffect, useRef } from 'react'
import { useMotionValue } from 'framer-motion'
import { CLIPS } from '../types'

export function useShowcaseTimer(
  activeIndex: number,
  setActiveIndex: (updater: (prev: number) => number) => void,
  paused: boolean,
  durationOverride: number | null
) {
  const progress = useMotionValue(0)
  const startTimeRef = useRef<number | null>(null)
  const pausedAtRef = useRef(0)
  const rafRef = useRef<number>(0)

  const duration = durationOverride ?? CLIPS[activeIndex].duration

  useEffect(() => {
    if (paused) {
      cancelAnimationFrame(rafRef.current)
      pausedAtRef.current = progress.get()
      startTimeRef.current = null
      return
    }

    const tick = (now: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = now - pausedAtRef.current * duration
      }

      const elapsed = now - startTimeRef.current
      const p = Math.min(elapsed / duration, 1)
      progress.set(p)

      if (p >= 1) {
        startTimeRef.current = null
        pausedAtRef.current = 0
        progress.set(0)
        setActiveIndex((prev) => (prev + 1) % CLIPS.length)
      } else {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [paused, duration, progress, setActiveIndex])

  const goTo = useCallback(
    (index: number) => {
      cancelAnimationFrame(rafRef.current)
      startTimeRef.current = null
      pausedAtRef.current = 0
      progress.set(0)
      setActiveIndex(() => index)
    },
    [progress, setActiveIndex]
  )

  return { progress, goTo }
}
