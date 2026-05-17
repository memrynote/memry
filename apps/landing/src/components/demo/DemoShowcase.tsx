import { useState, useCallback } from 'react'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { DemoTabs } from './DemoTabs'
import { DemoScene } from './DemoScene'
import { useShowcaseTimer } from './hooks/useShowcaseTimer'
import type { SeekRequest } from './types'

export function DemoShowcase() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(true)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)

  const { progress, goTo, seekTo } = useShowcaseTimer(
    activeIndex,
    setActiveIndex,
    paused,
    videoDuration
  )

  const handleTabClick = useCallback(
    (index: number) => {
      setVideoDuration(null)
      goTo(index)
      setPaused(false)
    },
    [goTo]
  )

  const handleToggle = useCallback(() => {
    setPaused((p) => !p)
  }, [])

  const handleDurationDetected = useCallback((ms: number) => {
    setVideoDuration(ms)
  }, [])

  const handleActiveTabSeek = useCallback(
    (nextProgress: number) => {
      seekTo(nextProgress)
      setSeekRequest((current) => ({
        progress: nextProgress,
        requestId: (current?.requestId ?? 0) + 1
      }))
    },
    [seekTo]
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
