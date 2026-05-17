import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function InboxScene({
  playing,
  muted,
  onMutedChange,
  onDurationDetected,
  seekRequest
}: SceneProps) {
  return (
    <VideoScene
      src="/demos/InboxVoice.mp4"
      playing={playing}
      muted={muted}
      onMutedChange={onMutedChange}
      onDurationDetected={onDurationDetected}
      seekRequest={seekRequest}
    />
  )
}
