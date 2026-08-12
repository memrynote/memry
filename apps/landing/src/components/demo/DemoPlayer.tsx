import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { ChapterRail, CHAPTERS } from '@/components/demo/ChapterRail'
import { DemoScene } from '@/components/demo/DemoScene'
import { useShowcaseTimer } from '@/components/demo/hooks/useShowcaseTimer'
import { CLIPS, type SeekRequest, type TabId } from '@/components/demo/types'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'
import { cn } from '@/lib/utils'

function demoTarget(clipId: TabId) {
  return `demo:${clipId}`
}

interface DemoPlayerProps {
  className?: string
  /**
   * Skip the muted teaser overlay and start engaged (video autoplays muted, no
   * play-to-start gate). Used when the player is opened intentionally — e.g. the
   * hero demo dialog, where the click that opened it already is the "start".
   */
  initialEngaged?: boolean
}

/**
 * The orchestrated demo player (Inbox/Journal/Notes/Tasks tabs + seek + mute).
 * Shared source of truth for the inline FlowShowcase section and the hero demo
 * dialog — both render this; only the surrounding chrome differs.
 */
export function DemoPlayer({ className, initialEngaged = false }: DemoPlayerProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [started, setStarted] = useState(true) // autoplay muted on mount
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(true)
  const [engaged, setEngaged] = useState(initialEngaged) // muted teaser overlay until first click
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)

  const handleProgressMilestone = useCallback((clipId: TabId, milestone: 25 | 50 | 75) => {
    trackLandingEvent(`landing_demo_progress_${milestone}` as LandingEventName, demoTarget(clipId))
  }, [])

  const handleClipComplete = useCallback((clipId: TabId) => {
    trackLandingEvent('landing_demo_complete', demoTarget(clipId))
  }, [])

  const { progress, goTo, seekTo } = useShowcaseTimer(
    activeIndex,
    setActiveIndex,
    paused || !started,
    videoDuration,
    handleClipComplete,
    handleProgressMilestone
  )

  const restartActiveVideo = useCallback(() => {
    setSeekRequest((current) => ({
      progress: 0,
      requestId: (current?.requestId ?? 0) + 1
    }))
  }, [])

  const handleStart = useCallback(() => {
    trackLandingEvent('landing_demo_start', demoTarget(CLIPS[activeIndex].id))
    setEngaged(true)
    setMuted(false)
    setStarted(true)
    setPaused(false)
    seekTo(0)
    restartActiveVideo()
  }, [activeIndex, restartActiveVideo, seekTo])

  const handleStepClick = useCallback(
    (index: number) => {
      trackLandingEvent('landing_demo_tab_click', demoTarget(CLIPS[index].id))
      if (!started) {
        trackLandingEvent('landing_demo_start', demoTarget(CLIPS[index].id))
      }
      setEngaged(true)
      setVideoDuration(null)
      goTo(index)
      restartActiveVideo()
      setStarted(true)
      setPaused(false)
    },
    [goTo, restartActiveVideo, started]
  )

  const handleToggle = useCallback(() => {
    if (!started) {
      handleStart()
      return
    }

    trackLandingEvent(
      paused ? 'landing_demo_resume' : 'landing_demo_pause',
      demoTarget(CLIPS[activeIndex].id)
    )
    setPaused((p) => !p)
  }, [activeIndex, handleStart, paused, started])

  const handleDurationDetected = useCallback((ms: number) => {
    setVideoDuration(ms)
  }, [])

  const handleVideoProgressChange = useCallback(
    (nextProgress: number) => {
      seekTo(nextProgress)
    },
    [seekTo]
  )

  const handleVideoPlaybackChange = useCallback(
    (isPlaying: boolean) => {
      if (isPlaying) {
        if (!started) {
          trackLandingEvent('landing_demo_start', demoTarget(CLIPS[activeIndex].id))
        }
        setStarted(true)
        setPaused(false)
        return
      }

      setPaused(true)
    },
    [activeIndex, started]
  )

  const handleActiveTabSeek = useCallback(
    (nextProgress: number) => {
      if (!started) {
        trackLandingEvent('landing_demo_start', demoTarget(CLIPS[activeIndex].id))
        setStarted(true)
        setPaused(false)
        seekTo(nextProgress)
        setSeekRequest((current) => ({
          progress: nextProgress,
          requestId: (current?.requestId ?? 0) + 1
        }))
        return
      }

      const eventName = nextProgress < progress.get() ? 'landing_demo_rewind' : 'landing_demo_seek'
      trackLandingEvent(eventName, demoTarget(CLIPS[activeIndex].id))
      seekTo(nextProgress)
      setSeekRequest((current) => ({
        progress: nextProgress,
        requestId: (current?.requestId ?? 0) + 1
      }))
    },
    [activeIndex, progress, seekTo, started]
  )

  const activeChapter = CHAPTERS[activeIndex]

  return (
    <div
      className={cn(
        'grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_320px]',
        className
      )}
    >
      <MockupFrame
        caption={
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={activeChapter.id}
              className="block"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              {activeChapter.title} — {activeChapter.tagline}
            </motion.span>
          </AnimatePresence>
        }
      >
        <DemoScene
          activeIndex={activeIndex}
          playing={started && !paused}
          muted={muted}
          previewing={!engaged}
          onToggle={handleToggle}
          onStart={handleStart}
          onMutedChange={setMuted}
          onDurationDetected={handleDurationDetected}
          onPlaybackChange={handleVideoPlaybackChange}
          onProgressChange={handleVideoProgressChange}
          seekRequest={seekRequest}
        />
      </MockupFrame>

      <ChapterRail
        activeIndex={activeIndex}
        playing={started && !paused}
        progress={progress}
        onChapterClick={handleStepClick}
        onActiveToggle={handleToggle}
        onActiveSeek={handleActiveTabSeek}
      />
    </div>
  )
}
