type FlushFn = () => Promise<void> | void

const pendingSaves = new Map<string, FlushFn>()

export function registerPendingSave(key: string, flushFn: FlushFn): void {
  pendingSaves.set(key, flushFn)
}

export function unregisterPendingSave(key: string): void {
  pendingSaves.delete(key)
}

export async function flushAllPendingSaves(): Promise<void> {
  const entries = Array.from(pendingSaves.entries())
  if (entries.length === 0) return

  await Promise.allSettled(entries.map(([, fn]) => Promise.resolve(fn())))
}

export function hasPendingSaves(): boolean {
  return pendingSaves.size > 0
}
