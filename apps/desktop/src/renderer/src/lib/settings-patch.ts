/**
 * Merge a `settings:changed` payload into local settings state, returning the
 * previous object unchanged when the patch carries nothing new.
 *
 * The main process fans `settings:changed` out to every window *including the
 * one that issued the write*, and that echo cannot be suppressed at the sender
 * (#1063): a single window holds many independent instances of the same
 * settings hook — `useGeneralSettings` alone has 28 consumer files, each with
 * its own `useState` and no shared context — and only the instance that
 * performed the write applies it optimistically. Excluding `event.sender` from
 * the fan-out, or filtering the event by a `sourceWindowId` in the renderer,
 * would leave all the sibling instances in the writer's window stale until
 * reload. The dedupe therefore belongs here, at the granularity that is
 * actually correct: the value.
 *
 * Returning `prev` by identity makes React bail out of the re-render, so an
 * echo that tells a subscriber what it already knows costs nothing. That covers
 * both the writer's own echo and the sync-apply path, which re-broadcasts the
 * whole merged `general` / `editor` / `inbox` blob on every applied settings
 * item even when no field on this device actually differs.
 *
 * The comparison is shallow, matching the merge it guards. Groups whose values
 * are nested objects (keyboard bindings) simply never hit the bail-out, which
 * is correct — just not a saving.
 */
export function mergeSettingsPatch<T extends object>(prev: T, patch: Partial<T>): T {
  let changed = false

  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (!Object.is(prev[key], patch[key])) {
      changed = true
      break
    }
  }

  return changed ? { ...prev, ...patch } : prev
}
