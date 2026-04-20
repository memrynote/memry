const DEFAULT_DURATION_MS = 60 * 60 * 1000

export interface LaneAssignment<T> {
  item: T
  lane: number
  laneCount: number
}

interface Timed<T> {
  item: T
  start: number
  end: number
}

function toTimed<T extends { startAt: string; endAt: string | null }>(item: T): Timed<T> {
  const start = new Date(item.startAt).getTime()
  const end = item.endAt ? new Date(item.endAt).getTime() : start + DEFAULT_DURATION_MS
  return { item, start, end }
}

export function assignLanes<T extends { startAt: string; endAt: string | null }>(
  items: T[]
): LaneAssignment<T>[] {
  if (items.length === 0) return []

  const timed = items.map(toTimed)
  timed.sort((a, b) => a.start - b.start || b.end - a.end)

  const output: LaneAssignment<T>[] = []
  let cluster: Timed<T>[] = []
  let clusterEnd = -Infinity

  const flush = (): void => {
    if (cluster.length === 0) return
    const laneEnds: number[] = []
    const laneByIndex: number[] = []
    for (let i = 0; i < cluster.length; i++) {
      const ev = cluster[i]
      let lane = laneEnds.findIndex((endTime) => endTime <= ev.start)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(ev.end)
      } else {
        laneEnds[lane] = ev.end
      }
      laneByIndex[i] = lane
    }
    const laneCount = laneEnds.length
    for (let i = 0; i < cluster.length; i++) {
      output.push({ item: cluster[i].item, lane: laneByIndex[i], laneCount })
    }
    cluster = []
    clusterEnd = -Infinity
  }

  for (const ev of timed) {
    if (ev.start >= clusterEnd) flush()
    cluster.push(ev)
    clusterEnd = Math.max(clusterEnd, ev.end)
  }
  flush()

  return output
}
