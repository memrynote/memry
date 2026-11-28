import { utcNow } from '@memry/shared/utc'

/**
 * The edit time a pass stamps on the note (#2515). A local edit happened now.
 * A remote pass is no edit made here: it keeps the row's time, moved forward
 * only to the server time of the remote edit it merged, never backwards. A
 * snapshot, a pack or an older peer's update carries no such time, so a
 * re-pull or a re-serialized body leaves the note where it was.
 */
export function writebackModifiedAt(
  current: string | null | undefined,
  local: boolean,
  remoteEditedAtMs: number | undefined
): string {
  if (local) return utcNow()
  const remoteMs =
    remoteEditedAtMs !== undefined && Number.isFinite(remoteEditedAtMs) && remoteEditedAtMs > 0
      ? remoteEditedAtMs
      : undefined
  const currentMs = current ? Date.parse(current) : NaN
  if (!current || !Number.isFinite(currentMs)) {
    return remoteMs !== undefined ? new Date(remoteMs).toISOString() : utcNow()
  }
  return remoteMs !== undefined && remoteMs > currentMs ? new Date(remoteMs).toISOString() : current
}

/** The later of two server edit times, either of which may be unknown. */
export function laterEditTime(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}
