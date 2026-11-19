// Reads the marks the bootstrap benchmark needs out of Electron's main.log.

const LOG_LINE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\]\s+\[[^\]]*\] (.*)$/

export function parseMainLog(text) {
  const events = []
  for (const line of text.split('\n')) {
    const match = LOG_LINE.exec(line)
    if (!match) continue
    const [, y, mo, d, h, mi, s, ms, message] = match
    const atMs = new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime()
    const fields = Object.fromEntries(
      [...message.matchAll(/(\w+): (-?\d+)/g)].map(([, key, value]) => [key, Number(value)])
    )
    events.push({ atMs, message, fields })
  }
  return events
}

export function electronMarks(events) {
  const first = (prefix, after = 0) =>
    events.find((e) => e.atMs >= after && e.message.startsWith(prefix))?.atMs ?? null
  const startMs = first('Bootstrap window opened')
  if (startMs === null) return null
  const sum = (prefix, key) =>
    events
      .filter((e) => e.atMs >= startMs && e.message.startsWith(prefix))
      .reduce((total, e) => total + (e.fields[key] ?? 0), 0)
  const count = (prefix) =>
    events.filter((e) => e.atMs >= startMs && e.message.startsWith(prefix)).length
  return {
    marks: {
      startMs,
      recordsMs: first('Pull timing', startMs) ?? first('fullSync: pull complete', startMs),
      bodiesMs: first('Bootstrap window closed', startMs)
    },
    staleLockReleases: count('Sync lock held past stale threshold'),
    shell: {
      pullPages: count('Pull page processed'),
      crdtGroups: count('pullCrdtForNotes completed'),
      snapshotGets: sum('pullCrdtForNotes completed', 'snapshotGets'),
      batchPosts: sum('pullCrdtForNotes completed', 'batchPosts'),
      packsApplied: sum('Pack bootstrap finished', 'packsApplied'),
      cursorSkipRepairs: count('fullSync: cursor-skip repair, re-pulling')
    }
  }
}
