import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { DemoTabs } from '@/components/demo/DemoTabs'
import { DemoScene } from '@/components/demo/DemoScene'
import { useShowcaseTimer } from '@/components/demo/hooks/useShowcaseTimer'
import { CLIPS, type SeekRequest, type TabId } from '@/components/demo/types'
import { FLOW_STEPS } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'

const INTERACTIVE_STEPS = FLOW_STEPS.filter((s) => CLIPS.some((c) => c.id === s.id))

function demoTarget(clipId: TabId) {
  return `demo:${clipId}`
}

function CompetitorBar({ activeIndex }: { activeIndex: number }) {
  const step = INTERACTIVE_STEPS[activeIndex]
  const label = 'competitorLabel' in step ? (step.competitorLabel as string) : 'Replaces'

  return (
    <div className="h-8 flex items-center justify-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          className="flex items-center gap-3"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="text-[11px] font-mono-accent uppercase tracking-wider text-muted/40">
            {label}
          </span>
          <div className="flex items-center gap-2">
            {step.competitors.map((c) => (
              <img
                key={c.name}
                src={c.logo}
                alt={c.name}
                title={c.name}
                width={18}
                height={18}
                loading="lazy"
                decoding="async"
                className="w-[18px] h-[18px] rounded-sm opacity-60 hover:opacity-100 transition-opacity"
              />
            ))}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export function FlowShowcase() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [started, setStarted] = useState(true) // autoplay muted on mount
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(true)
  const [engaged, setEngaged] = useState(false) // muted teaser overlay until first click
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

  return (
    <section className="pt-8 pb-4 md:pt-12">
      <Container>
        <motion.div
          className="max-w-4xl mx-auto"
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
        >
          <div className="mb-6 flex items-baseline justify-between gap-4">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              § 01 — Exhibit A
            </p>
            <p className="font-serif text-lg italic text-muted">The app, unedited.</p>
          </div>

          <MockupFrame caption="Full app walkthrough — click the bar to jump">
            <div className="flex flex-col">
              <div className="px-3 py-2 border-b border-border/30">
                <DemoTabs
                  activeIndex={activeIndex}
                  progress={progress}
                  onTabClick={handleStepClick}
                  onActiveTabSeek={handleActiveTabSeek}
                />
              </div>
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
            </div>
          </MockupFrame>

          <div className="mt-3">
            <CompetitorBar activeIndex={activeIndex} />
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
