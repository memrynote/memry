export type VoiceRecordingReadiness = Awaited<
  ReturnType<typeof window.api.settings.getVoiceRecordingReadiness>
>

export function getVoiceRecordingSettingsTarget(
  readiness: VoiceRecordingReadiness
): 'ai' | 'ai:voice-local-model' {
  return readiness.reason === 'missing-model' ? 'ai:voice-local-model' : 'ai'
}

export async function ensureVoiceRecordingReady(
  onBlocked: (readiness: VoiceRecordingReadiness) => void | Promise<void>
): Promise<boolean> {
  const readiness = await window.api.settings.getVoiceRecordingReadiness()

  if (readiness.ready) {
    return true
  }

  await onBlocked(readiness)
  return false
}
