export async function ensureVoiceRecordingReady(
  onBlocked: () => void | Promise<void>
): Promise<boolean> {
  const readiness = await window.api.settings.getVoiceRecordingReadiness()

  if (readiness.ready) {
    return true
  }

  await onBlocked()
  return false
}
