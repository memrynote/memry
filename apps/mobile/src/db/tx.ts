import type { VaultDb } from './index'

/**
 * The one way to open a transaction on a vault DB.
 *
 * expo-sqlite gives a database ONE connection, and `withTransactionAsync`
 * issues a bare `BEGIN`: two overlapping calls throw "cannot start a
 * transaction within a transaction". That is not a theoretical race here —
 * the editor persists keystrokes, note operations write metadata, compaction
 * folds CRDT rows and the pull applier applies batches, all against the same
 * connection, all triggered by independent user actions and timers.
 *
 * The failure is worse than a visible error: a losing editor transaction is
 * caught and logged, so the keystroke is neither persisted nor enqueued, and a
 * losing note write rejects after the UI has already shown the change.
 *
 * So every writer queues here. The lock is per database instance rather than
 * global, because separate vaults are separate connections and serializing
 * across them would be pure latency.
 */

const chains = new WeakMap<VaultDb, Promise<unknown>>()

export function withVaultTransaction<T>(db: VaultDb, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(db) ?? Promise.resolve()

  // `then(run, run)`: a failed predecessor must not stop the queue, and its
  // rejection is the caller's to handle, not this one's.
  const run = async (): Promise<T> => {
    let result: T
    // expo-sqlite's wrapper discards the callback's value, so it is carried
    // out by hand.
    await db.withTransactionAsync(async () => {
      result = await fn()
    })
    return result!
  }

  const settled = previous.then(run, run)
  chains.set(
    db,
    settled.then(
      () => undefined,
      () => undefined
    )
  )
  return settled
}
