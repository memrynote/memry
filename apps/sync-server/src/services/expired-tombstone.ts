/**
 * A `sync_items si` row the shed takes: a tombstone past the owner's
 * retention. Needs `LEFT JOIN sync_entitlements e ON e.user_id = si.user_id`
 * and binds `now` (epoch seconds). Pack compaction reads it too, so it never
 * leaves a hole for a row the shed will empty in place (#5227), and the record
 * purge rewrite drops such a row's entry before the shed (#5247).
 */
export const EXPIRED_TOMBSTONE_SQL = `si.deleted_at IS NOT NULL
         AND (CASE WHEN si.deleted_at >= 100000000000 THEN si.deleted_at / 1000 ELSE si.deleted_at END)
             < ? - (COALESCE(e.version_history_days, 0) * 86400)`
