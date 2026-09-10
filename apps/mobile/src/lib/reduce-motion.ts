/**
 * "Reduce motion" as a value that CHANGES, not one read once at mount.
 *
 * iOS and Android let the reader flip the setting from Control Centre or
 * Settings while the app is in the foreground, and `AccessibilityInfo` is the
 * only source for it — there is no synchronous getter, so the first value
 * always arrives on a promise. A surface that awaited it once would keep
 * animating for the rest of the session after the reader turned motion off,
 * which is exactly the failure DESIGN.md's reduced-motion requirement is about.
 *
 * The source is injected rather than imported so this can be tested at all:
 * mobile's vitest runs in plain Node, where importing `react-native` is not
 * possible.
 */
export interface ReduceMotionSource {
  /** The current value. Async because `isReduceMotionEnabled()` is. */
  read: () => Promise<boolean>
  /** Subscribe to later changes; the returned function unsubscribes. */
  subscribe: (listener: (enabled: boolean) => void) => () => void
}

/**
 * Push the current value, then every later one, into `onChange`.
 *
 * Returns a disposer. It unsubscribes AND drops a `read()` that has not settled
 * yet: on a fast note-to-note tap the promise can resolve after the screen is
 * gone, and delivering it then would set state on an unmounted surface.
 */
export function watchReduceMotion(
  source: ReduceMotionSource,
  onChange: (enabled: boolean) => void
): () => void {
  let live = true
  const deliver = (enabled: boolean): void => {
    if (live) onChange(enabled)
  }
  const unsubscribe = source.subscribe(deliver)
  void source.read().then(deliver, () => {
    // A platform that cannot answer is not a reason to fail the screen; the
    // caller's initial `false` stands and any later change event still lands.
  })
  return () => {
    live = false
    unsubscribe()
  }
}
