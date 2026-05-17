import { useState, useCallback } from 'react'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { DemoTabs } from './DemoTabs'
import { DemoScene } from './DemoScene'
import { useShowcaseTimer } from './hooks/useShowcaseTimer'
import { CLIPS, type SeekRequest, type TabId } from './types'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'

function demoTarget(clipId: TabId) {
  return `demo:${clipId}`
}

export function DemoShowcase() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(true)
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
    paused,
    videoDuration,
    handleClipComplete,
    handleProgressMilestone
  )

  const handleTabClick = useCallback(
    (index: number) => {
      trackLandingEvent('landing_demo_tab_click', demoTarget(CLIPS[index].id))
      setVideoDuration(null)
      goTo(index)
      setPaused(false)
    },
    [goTo]
  )

  const handleToggle = useCallback(() => {
    trackLandingEvent(
      paused ? 'landing_demo_resume' : 'landing_demo_pause',
      demoTarget(CLIPS[activeIndex].id)
    )
    setPaused((p) => !p)
  }, [activeIndex, paused])

  const handleDurationDetected = useCallback((ms: number) => {
    setVideoDuration(ms)
  }, [])

  const handleActiveTabSeek = useCallback(
    (nextProgress: number) => {
      const eventName = nextProgress < progress.get() ? 'landing_demo_rewind' : 'landing_demo_seek'
      trackLandingEvent(eventName, demoTarget(CLIPS[activeIndex].id))
      seekTo(nextProgress)
      setSeekRequest((current) => ({
        progress: nextProgress,
        requestId: (current?.requestId ?? 0) + 1
      }))
    },
    [activeIndex, progress, seekTo]
  )

  return (
    <MockupFrame>
      <div className="flex flex-col">
        <div className="px-3 py-2 border-b border-border/30">
          <DemoTabs
            activeIndex={activeIndex}
            progress={progress}
            onTabClick={handleTabClick}
            onActiveTabSeek={handleActiveTabSeek}
          />
        </div>
        <DemoScene
          activeIndex={activeIndex}
          playing={!paused}
          muted={muted}
          onToggle={handleToggle}
          onMutedChange={setMuted}
          onDurationDetected={handleDurationDetected}
          seekRequest={seekRequest}
        />
      </div>
    </MockupFrame>
  )
}
