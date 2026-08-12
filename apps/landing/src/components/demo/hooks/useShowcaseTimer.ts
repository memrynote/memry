import { useCallback, useEffect, useRef } from 'react'
import { useMotionValue } from 'motion/react'
import { CLIPS, type TabId } from '../types'

type ProgressMilestone = 25 | 50 | 75

const PROGRESS_MILESTONES: readonly ProgressMilestone[] = [25, 50, 75]

export function useShowcaseTimer(
  activeIndex: number,
  setActiveIndex: (updater: (prev: number) => number) => void,
  paused: boolean,
  durationOverride: number | null,
  onClipComplete?: (clipId: TabId) => void,
  onProgressMilestone?: (clipId: TabId, milestone: ProgressMilestone) => void
) {
  const progress = useMotionValue(0)
  const startTimeRef = useRef<number | null>(null)
  const pausedAtRef = useRef(0)
  const rafRef = useRef<number>(0)
  const firedMilestonesRef = useRef<Set<ProgressMilestone>>(new Set())

  const duration = durationOverride ?? CLIPS[activeIndex].duration

  const resetProgressMilestones = useCallback(() => {
    firedMilestonesRef.current = new Set()
  }, [])

  const pruneProgressMilestones = useCallback((nextProgress: number) => {
    for (const milestone of firedMilestonesRef.current) {
      if (milestone / 100 > nextProgress) {
        firedMilestonesRef.current.delete(milestone)
      }
    }
  }, [])

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

      for (const milestone of PROGRESS_MILESTONES) {
        if (p >= milestone / 100 && !firedMilestonesRef.current.has(milestone)) {
          firedMilestonesRef.current.add(milestone)
          onProgressMilestone?.(CLIPS[activeIndex].id, milestone)
        }
      }

      if (p >= 1) {
        onClipComplete?.(CLIPS[activeIndex].id)
        startTimeRef.current = null
        pausedAtRef.current = 0
        resetProgressMilestones()
        progress.set(0)
        setActiveIndex((prev) => (prev + 1) % CLIPS.length)
      } else {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [
    activeIndex,
    duration,
    onClipComplete,
    onProgressMilestone,
    paused,
    progress,
    resetProgressMilestones,
    setActiveIndex
  ])

  const goTo = useCallback(
    (index: number) => {
      cancelAnimationFrame(rafRef.current)
      startTimeRef.current = null
      pausedAtRef.current = 0
      resetProgressMilestones()
      progress.set(0)
      setActiveIndex(() => index)
    },
    [progress, resetProgressMilestones, setActiveIndex]
  )

  const seekTo = useCallback(
    (nextProgress: number) => {
      const clampedProgress = Math.min(Math.max(nextProgress, 0), 1)
      progress.set(clampedProgress)
      pausedAtRef.current = clampedProgress
      pruneProgressMilestones(clampedProgress)
      startTimeRef.current = paused ? null : performance.now() - clampedProgress * duration
    },
    [duration, paused, progress, pruneProgressMilestones]
  )

  return { progress, goTo, seekTo }
}
