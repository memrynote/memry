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
      // Logged once every record is applied and before the run's last body
      // batch; `Pull timing` waits for that batch, so it lands near t_bodies.
      recordsMs: first('Pull records applied', startMs),
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

const KEPT_PREFIXES = [
  'Bootstrap window',
  'Pull records applied',
  'Pull timing',
  'fullSync:',
  'Pull page processed',
  'pullCrdtForNotes completed',
  'Pack bootstrap finished',
  'Sync lock held past stale threshold'
]

/**
 * Follows main.log across the logger's renames (main.log -> main.1.log at
 * 5 MB, four archives kept), so a long run keeps its first lines. Each call
 * reads what was appended since the last one and returns the lines whose
 * message starts with one of `prefixes`. Tauri writes the same file name and
 * line layout.
 */
export function followLog(logPath, fs, prefixes = KEPT_PREFIXES) {
  const archivePath = logPath.replace(/\.log$/, '.1.log')
  let inode = null
  let offset = 0
  let partial = ''
  const lines = []

  const readFrom = (file, from) => {
    const size = fs.statSync(file).size
    if (size <= from) return ''
    const buffer = Buffer.alloc(size - from)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, buffer.length, from)
    } finally {
      fs.closeSync(fd)
    }
    return buffer.toString('utf8')
  }

  return () => {
    if (!fs.existsSync(logPath)) return lines
    let text = ''
    const current = fs.statSync(logPath).ino
    if (inode !== null && current !== inode) {
      // Rotated since the last read: finish the old file under its new name.
      if (fs.existsSync(archivePath) && fs.statSync(archivePath).ino === inode) {
        text += readFrom(archivePath, offset)
      }
      offset = 0
    }
    inode = current
    const fresh = readFrom(logPath, offset)
    offset += Buffer.byteLength(fresh)
    text = partial + text + fresh
    const split = text.split('\n')
    partial = split.pop() ?? ''
    for (const line of split) {
      if (prefixes.some((prefix) => line.includes(`] ${prefix}`))) lines.push(line)
    }
    return lines
  }
}
