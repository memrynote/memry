/**
 * Fetches `items` ahead of an in-order consumer. `take(i)` starts the fetches
 * for `i .. i + width - 1` that have not started and returns item `i`'s
 * promise. The caller still awaits and applies one item at a time, in order,
 * so only the network waits overlap. Nothing starts past the last `take`, so a
 * consumer that stops early wastes at most `width - 1` fetches. A prefetched
 * rejection is held until its `take` awaits it, and never reported as
 * unhandled when the consumer stops before reaching it.
 */
export function prefetchWindow<T, R>(
  items: readonly T[],
  width: number,
  fetch: (item: T) => Promise<R>
): (index: number) => Promise<R> {
  const started: Promise<R>[] = []
  return (index) => {
    const end = Math.min(items.length, index + Math.max(1, width))
    for (let i = started.length; i < end; i++) {
      const pending = fetch(items[i])
      pending.catch(() => {})
      started.push(pending)
    }
    return started[index]
  }
}
