/**
 * Thrown by the pull apply for an item whose local edit is not clocked yet: its
 * sync intent is still pending (#2301). The pull defers the item to the
 * schema-invalid ledger (`pending_intent`) instead of applying it over the edit.
 */
export class PendingSyncIntentError extends Error {
  constructor(
    readonly type: string,
    readonly itemId: string
  ) {
    super('A local sync intent for this item is still pending')
    this.name = 'PendingSyncIntentError'
  }
}
