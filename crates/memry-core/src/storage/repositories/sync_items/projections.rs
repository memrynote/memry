//! Replaying stored payloads through their projectors: the full rebuild and the
//! open-time canvas heal.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::migrations::{self, DATA_MIGRATIONS};
use crate::storage::nested_tx;

use super::{load, mark_corrupt};
use crate::storage::repositories::payload::StoredPayload;
use crate::storage::repositories::projectors::{self, ItemContext, failed};

/// Replays every stored payload through its projector (§A.1).
///
/// Dropping the tables of migration `0002` and calling this is a supported
/// recovery, and it is the operation that makes "a projection column is a cache
/// of a parse" true rather than aspirational. Returns how many rows projected.
/// A row that fails its reader is flagged and passed over, not retried.
pub fn rebuild_projections(conn: &Connection, now_ms: i64) -> Result<usize, StorageError> {
    replay(
        conn,
        "SELECT item_type, item_id FROM sync_items WHERE payload IS NOT NULL
         ORDER BY item_type, item_id",
        Some(now_ms),
    )
}

/// Projects every `canvas` payload whose `canvases` row (migration `0037`) is
/// missing or older than the payload, on every open of `data.db`, in one
/// transaction. Payloads reach `sync_items` without this build's projector:
/// stored before `0037`, written by an older build that opened the migrated
/// file (its `run` skips the versions it knows, and its canvas projector is a
/// no-op), or salvaged by a recovery into a file migrated while empty. A row
/// the projector wrote has `synced_at` equal to its payload's `updated_at`, so
/// only those rows match, and a crash leaves them for the next open.
///
/// A replayed row takes its `sync_items.updated_at` as its apply instant, so a
/// table listed by recency keeps the order its rows had. A row held corrupt
/// stays out, or each open would re-read and re-flag it. A database written by
/// a newer build is left alone: its projector may differ from this one.
pub fn heal_projections(conn: &Connection) -> Result<usize, StorageError> {
    let newer = migrations::user_version(conn)? > migrations::latest_version(DATA_MIGRATIONS);
    if newer {
        return Ok(0);
    }
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let healed = replay(
        &tx,
        "SELECT s.item_type, s.item_id FROM sync_items s
         LEFT JOIN canvases c ON c.id = s.item_id
         WHERE s.item_type = 'canvas' AND s.payload IS NOT NULL
           AND s.corrupt_reason IS NULL
           AND (c.id IS NULL OR c.synced_at IS NULL OR c.synced_at < s.updated_at)
         ORDER BY s.item_id",
        None,
    )?;
    tx.commit().map_err(failed)?;
    Ok(healed)
}

/// Projects the payloads `keys_sql` names by `(item_type, item_id)`. `now_ms`
/// is the apply instant, or `None` for each row's own `updated_at`. Keys are
/// read first and payloads one at a time, so a vault of large canvas scenes is
/// never held in memory at once.
fn replay(conn: &Connection, keys_sql: &str, now_ms: Option<i64>) -> Result<usize, StorageError> {
    let keys: Vec<(String, String)> = {
        let mut statement = conn.prepare(keys_sql).map_err(failed)?;
        let mapped = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?;
        mapped.collect::<Result<_, _>>().map_err(failed)?
    };

    let mut projected = 0;
    for (item_type, item_id) in keys {
        let Some(row) = load(conn, &item_type, &item_id)? else {
            continue;
        };
        let Some(stored) = row.payload else {
            continue;
        };
        let at = now_ms.unwrap_or(row.updated_at);
        let read = StoredPayload::parse(&stored)
            .and_then(|payload| projectors::read(&item_type, payload.object()));
        match read {
            Ok(view) => {
                projectors::project(
                    conn,
                    &item_type,
                    ItemContext {
                        item_id: &item_id,
                        synced_at: at,
                        deleted_at: row.deleted_at,
                    },
                    &view,
                )?;
                projected += 1;
            }
            Err(error) => mark_corrupt(conn, &item_type, &item_id, &error.to_string(), at)?,
        }
    }
    Ok(projected)
}
