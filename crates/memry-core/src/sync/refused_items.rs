//! The refused-items ledger (#4453, chapter 13 §13.2 rule 5): the core's equal
//! of desktop's `SchemaInvalidLedger`
//! (`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts`), `payload`
//! kind.
//!
//! The one record cursor moves past a record this build's schema refused
//! ([`crate::domain::tasks::Inbound::Refused`]), so this table is what brings
//! it back: the pull records `(type, id)` with the app version that refused
//! it, and refetches it by id once another app version runs
//! ([`super::pull::PullLoop::run`]). The local row is never touched, so its own
//! edits keep syncing. A later apply of the item, or a refetch the server
//! answers without it, resolves the entry.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// One ledger row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedItem {
    pub item_type: String,
    pub item_id: String,
    pub refused_by_version: String,
}

/// Records each `(type, id)` as refused by `version`, replacing an earlier
/// entry of the same item.
pub(crate) fn record(
    conn: &Connection,
    refused: &[(String, String)],
    version: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    for (item_type, item_id) in refused {
        conn.execute(
            "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (item_type, item_id) DO UPDATE SET
               refused_by_version = excluded.refused_by_version,
               refused_at = excluded.refused_at",
            params![item_type, item_id, version, now_ms],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Drops the entry of `(item_type, item_id)`: the record applied or was
/// decided by its clock.
pub(crate) fn resolve(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM sync_refused_items WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id],
    )
    .map(drop)
    .map_err(failed)
}

/// The ids another app version refused, which this one refetches.
pub(crate) fn retryable(conn: &Connection, version: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT item_id FROM sync_refused_items
             WHERE refused_by_version <> ?1 ORDER BY item_id",
        )
        .map_err(failed)?;
    let ids = statement
        .query_map(params![version], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(failed)?;
    Ok(ids)
}

/// After a refetch of `ids` the server answered in full: an entry still on
/// another version was neither applied nor refused again, so the server no
/// longer holds the item (desktop resolves these as `missing`).
pub(crate) fn resolve_unanswered(
    conn: &Connection,
    ids: &[String],
    version: &str,
) -> Result<(), StorageError> {
    for item_id in ids {
        conn.execute(
            "DELETE FROM sync_refused_items WHERE item_id = ?1 AND refused_by_version <> ?2",
            params![item_id, version],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Every ledger row, ordered by type and id.
pub fn entries(conn: &Connection) -> Result<Vec<RefusedItem>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_type, item_id, refused_by_version FROM sync_refused_items
             ORDER BY item_type, item_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(RefusedItem {
                item_type: row.get(0)?,
                item_id: row.get(1)?,
                refused_by_version: row.get(2)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows)
}
