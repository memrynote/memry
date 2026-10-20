/**
 * A zero-byte file has nothing to upload and will fail identically on every
 * retry, so the outbox drops its row instead of backing off and retrying (#3414).
 * A later write re-queues the path through the body-save or backfill route.
 */
export class EmptyAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyAttachmentError'
  }
}
