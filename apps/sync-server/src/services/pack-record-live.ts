import type { VaultScope } from './pack-index-write'

/**
 * The packed record entries that are still their row's current write: the row
 * sits at the entry's cursor with the entry's blob and is not a marker
 * (protocol 08 §8.12). A row a later push moved, or the shed emptied, drops.
 * A `FROM` clause for `allLive` and the rollup. CROSS JOIN keeps `json_each`
 * outer, as snapshotsLive does.
 */
export const recordsLive = (
  scope: VaultScope,
  entries: ReadonlyArray<{ sortKey: number; sourceKey: string }>
): { sql: string; bind: unknown[] } => ({
  sql: `FROM json_each(?) e CROSS JOIN sync_items s
          ON s.user_id = ? AND s.vault_id = ? AND s.server_cursor = json_extract(e.value, '$[0]')
            AND s.blob_key = json_extract(e.value, '$[1]') AND s.blob_key <> ''`,
  bind: [
    JSON.stringify(entries.map((entry) => [entry.sortKey, entry.sourceKey])),
    scope.userId,
    scope.vaultId
  ]
})
