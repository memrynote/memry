// The last few units of work the main process started, for the stall monitor
// (main-thread-stall.ts). A stall log used to say only how long the loop was
// blocked, so the field showed repeated 10 s stalls on Windows that nothing
// could attribute. The loop is single-threaded: the work that blocked it is,
// almost always, the last one started before the stall began.
//
// Names are code-defined labels (an IPC channel, a projector and event type),
// never user data, because they ship with the stall log.

export interface MainActivity {
  name: string
  startedAt: number
}

export const MAIN_ACTIVITY_LIMIT = 8

const recent: MainActivity[] = []

export function markMainActivity(name: string): void {
  recent.push({ name, startedAt: Date.now() })
  if (recent.length > MAIN_ACTIVITY_LIMIT) recent.shift()
}

/** Oldest first. */
export function recentMainActivity(): readonly MainActivity[] {
  return recent
}
