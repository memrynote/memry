import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function InboxScene({
  clipId,
  playing,
  muted,
  onMutedChange,
  onDurationDetected,
  seekRequest
}: SceneProps) {
  return (
    <VideoScene
      clipId={clipId}
      src="/demos/InboxVoice.mp4"
      playing={playing}
      muted={muted}
      onMutedChange={onMutedChange}
      onDurationDetected={onDurationDetected}
      seekRequest={seekRequest}
    />
  )
}
