/**
 * Compatibility shim for the pre-projection embedding queue.
 *
 * Embedding updates are now driven by note projection events. The old queue
 * remains as a no-op surface so existing callers can be removed incrementally.
 */

export function queueEmbeddingUpdate(_noteId: string): void {}

export async function processEmbeddingQueue(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  return { processed: 0, succeeded: 0, failed: 0 }
}

export function clearEmbeddingQueue(): void {}

export function getPendingEmbeddingCount(): number {
  return 0
}

export function hasPendingEmbeddings(): boolean {
  return false
}

export function isQueueProcessing(): boolean {
  return false
}

export async function flushEmbeddingQueue(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  return { processed: 0, succeeded: 0, failed: 0 }
}
