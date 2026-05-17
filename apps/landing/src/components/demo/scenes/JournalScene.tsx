import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function JournalScene({
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
      src="/demos/JournalVoice.mp4"
      playing={playing}
      muted={muted}
      onMutedChange={onMutedChange}
      onDurationDetected={onDurationDetected}
      seekRequest={seekRequest}
    />
  )
}
