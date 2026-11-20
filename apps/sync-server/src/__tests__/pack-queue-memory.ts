import { runPackBackfill } from '../services/pack-backfill'
import { handlePackQueueMessage } from '../services/pack-consumer'
import type { PackCompactionMessageBody } from '../services/pack-queue'

export interface SentMessage {
  body: PackCompactionMessageBody
  delaySeconds?: number
}

/** A pack queue that records every send, in order, for tests to deliver. */
export const createMemoryQueue = (): Queue<PackCompactionMessageBody> & { sent: SentMessage[] } => {
  const sent: SentMessage[] = []
  return {
    sent,
    send: async (body, options) => {
      sent.push({ body, ...(options?.delaySeconds ? { delaySeconds: options.delaySeconds } : {}) })
    },
    sendBatch: async (messages, options) => {
      for (const message of messages) {
        const delaySeconds = message.delaySeconds ?? options?.delaySeconds
        sent.push({ body: message.body, ...(delaySeconds ? { delaySeconds } : {}) })
      }
    }
  }
}

/**
 * One cron tick (#5278), then every message it and its chains enqueue,
 * delivered in send order with each delay taken as elapsed.
 */
export const runBackfillTick = async (
  db: D1Database,
  storage: R2Bucket
): Promise<{ enqueued: number; messages: SentMessage[] }> => {
  const queue = createMemoryQueue()
  const { enqueued } = await runPackBackfill(db, storage, queue)
  for (let i = 0; i < queue.sent.length; i++) {
    await handlePackQueueMessage(
      { DB: db, STORAGE: storage, PACK_QUEUE: queue },
      queue.sent[i].body
    )
  }
  return { enqueued, messages: queue.sent }
}
