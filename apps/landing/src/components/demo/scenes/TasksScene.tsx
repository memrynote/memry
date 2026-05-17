import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function TasksScene({
  playing,
  muted,
  onMutedChange,
  onDurationDetected,
  seekRequest
}: SceneProps) {
  return (
    <VideoScene
      src="/demos/TaskVoice.mp4"
      playing={playing}
      muted={muted}
      onMutedChange={onMutedChange}
      onDurationDetected={onDurationDetected}
      seekRequest={seekRequest}
    />
  )
}
