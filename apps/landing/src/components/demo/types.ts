export type TabId = 'inbox' | 'journal' | 'notes' | 'tasks'

export interface ClipConfig {
  id: TabId
  label: string
  duration: number
}

export interface SceneProps {
  playing: boolean
  onDurationDetected?: (ms: number) => void
}

export const CLIPS: ClipConfig[] = [
  { id: 'inbox', label: 'Inbox', duration: 10_000 },
  { id: 'journal', label: 'Journal', duration: 8_000 },
  { id: 'notes', label: 'Notes', duration: 8_000 },
  { id: 'tasks', label: 'Tasks', duration: 8_000 }
]
