import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function TasksScene({ playing, onDurationDetected }: SceneProps) {
  return (
    <VideoScene src="/demos/task.mp4" playing={playing} onDurationDetected={onDurationDetected} />
  )
}
