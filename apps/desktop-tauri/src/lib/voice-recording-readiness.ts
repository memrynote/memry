import { invoke } from '@/lib/ipc/invoke'

export async function ensureVoiceRecordingReady(
  onBlocked: () => void | Promise<void>
): Promise<boolean> {
  const readiness = await invoke<{ ready: boolean }>('settings_get_voice_recording_readiness')

  if (readiness.ready) {
    return true
  }

  await onBlocked()
  return false
}
