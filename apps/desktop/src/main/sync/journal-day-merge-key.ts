/**
 * The `sync_state` key prefix of an owed journal day merge, one row per
 * foreign id. A leaf module, so sign-out's keep-set reads it without loading
 * the drain's vault and CRDT graph.
 */
export const JOURNAL_DAY_MERGE_KEY_PREFIX = 'journalDayMerge:'
