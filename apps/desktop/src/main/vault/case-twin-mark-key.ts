import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'

/**
 * The `sync_state` key prefix of a case twin's foreign-bytes mark, one row per
 * note. A leaf module, so sign-out's keep-set reads it without loading the
 * vault and storage graph.
 */
export const CASE_TWIN_MARK_PREFIX = `${SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES}:`
