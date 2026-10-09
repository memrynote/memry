import type { Message } from '../storage/types'

/**
 * The conversation as the model sees it: each summary in place of the messages it
 * covers, then every message no summary covers, in order. Compaction markers are
 * the only summaries; the result holds no other system 'compacted' messages.
 *
 * Marker payloads are a synced format. A marker with `summarizedFromStart: true`
 * covers everything through `summarizedThroughId` and replaces every earlier
 * summary. A marker without it was written by an older build: it covers only the
 * messages after the previous marker's position through `summarizedThroughId`, so
 * earlier summaries and the messages between them stay in the view. A marker whose
 * `summarizedThroughId` is missing, unknown or before its window covers nothing and stays in place.
 */
export function compactionView(history: Message[]): Message[] {
  const sorted = [...history].sort((a, b) => a.createdAt - b.createdAt)
  const covers: { marker: Message; from: number; through: number }[] = []
  const unresolved = new Set<Message>()
  let previousMarker = -1

  sorted.forEach((message, index) => {
    if (message.content.role !== 'system' || message.content.data.kind !== 'compacted') return
    const payload = message.content.data.payload
    const from = payload.summarizedFromStart === true ? 0 : previousMarker + 1
    const through =
      typeof payload.summarizedThroughId === 'string'
        ? sorted.findIndex((item) => item.id === payload.summarizedThroughId)
        : -1
    if (through < from) {
      unresolved.add(message)
    } else {
      if (from === 0) covers.length = 0
      covers.push({ marker: message, from, through })
    }
    previousMarker = index
  })

  const view: Message[] = []
  sorted.forEach((message, index) => {
    const cover = covers.find((item) => index >= item.from && index <= item.through)
    if (cover) {
      if (!view.includes(cover.marker)) view.push(cover.marker)
    } else if (unresolved.has(message) || !isCompactionMarker(message)) {
      view.push(message)
    }
  })
  return view
}

export function isCompactionMarker(message: Message): boolean {
  return message.content.role === 'system' && message.content.data.kind === 'compacted'
}
