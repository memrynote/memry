//! The refused-items ledger (#4453, chapter 13 §13.2 rule 5): the core's equal
//! of desktop's `SchemaInvalidLedger`
//! (`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts`), `payload`
//! kind.
//!
//! The one record cursor moves past a record this build's schema refused
//! ([`crate::domain::tasks::Inbound::Refused`]), so this table is what brings
//! it back: the pull records `(type, id)` with the core build that refused it
//! ([`CORE_BUILD`]), and refetches it by id once another core build runs
//! ([`super::pull::PullLoop::pull_first_page`]). The local row is never
//! touched, so its own edits keep syncing. A later apply of the item, a
//! tombstone, or a refetch the server answers without it resolves the entry.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The core build an entry is keyed on (`build.rs`): `<package version>+<git
/// commit>`. The refusal is this code's decision, so its build, not the shell's
/// app version, says when to ask again.
pub const CORE_BUILD: &str = env!("MEMRY_CORE_BUILD");

/// One ledger row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedItem {
    pub item_type: String,
    pub item_id: String,
    pub refused_by_version: String,
}

/// Records each `(type, id)` as refused by core build `version`, replacing an
/// earlier entry of the same item.
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

/// How long a kept entry waits before the next refetch: desktop's
/// `CORRUPT_ITEM_COOLDOWN_MS`
/// (`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts:88-90`).
pub const RETRY_COOLDOWN_MS: i64 = 3_600_000;

/// The `(type, id)` of every entry another core build refused and not tried
/// within [`RETRY_COOLDOWN_MS`], stamped as tried at `now_ms`. An entry the
/// refetch does not settle keeps its build and waits out the cooldown.
pub(crate) fn take_retryable(
    conn: &Connection,
    build: &str,
    now_ms: i64,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "UPDATE sync_refused_items SET refused_at = ?3
             WHERE refused_by_version <> ?1 AND refused_at <= ?2
             RETURNING item_type, item_id",
        )
        .map_err(failed)?;
    let mut pairs = statement
        .query_map(params![build, now_ms - RETRY_COOLDOWN_MS, now_ms], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<(String, String)>, _>>()
        .map_err(failed)?;
    pairs.sort();
    Ok(pairs)
}

/// Drops every entry under `item_id`: an untyped tombstone deleted every row
/// under it (§5.12.1).
pub(crate) fn resolve_id(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM sync_refused_items WHERE item_id = ?1",
        params![item_id],
    )
    .map(drop)
    .map_err(failed)
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
