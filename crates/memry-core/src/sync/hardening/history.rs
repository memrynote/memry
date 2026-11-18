//! Sync history (Step 17 L3a, #3534): the rows Electron's
//! `SyncStateManager.recordHistory` writes (`apps/desktop/src/main/sync/
//! engine/sync-state-manager.ts:223-241`) and the sync settings list as
//! `SyncHistoryEntry` (`packages/contracts/src/ipc-sync-ops.ts:165-173`), in
//! `sync_history` (migration 0031). `SyncDriver` records a row per pass:
//! the pull when it succeeded, the push when it sent something, and the
//! error when the pass failed. The newest [`KEEP`] rows are kept.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;

/// Rows kept, newest first.
pub const KEEP: i64 = 500;

/// `SyncHistoryEntry.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryKind {
    Push,
    Pull,
    Error,
}

impl HistoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::Pull => "pull",
            Self::Error => "error",
        }
    }
}

/// One `sync_history` row. `kind` is the stored text, so a row a newer build
/// wrote still reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: String,
    pub kind: String,
    pub item_count: i64,
    pub direction: Option<String>,
    pub details: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A random UUID v4, as `crypto.randomUUID()` gives Electron's ids.
pub(crate) fn uuid_v4() -> String {
    let mut bytes = random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Records one row, then drops all but the newest [`KEEP`]. An error row has
/// no direction; a push or pull row's direction is its kind, as Electron's.
pub(crate) fn record(
    conn: &Connection,
    kind: HistoryKind,
    item_count: usize,
    duration_ms: i64,
    details: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let direction = (kind != HistoryKind::Error).then(|| kind.as_str());
    conn.execute(
        "INSERT INTO sync_history
           (id, kind, item_count, direction, details, duration_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            uuid_v4(),
            kind.as_str(),
            i64::try_from(item_count).unwrap_or(i64::MAX),
            direction,
            details,
            duration_ms,
            now_ms
        ],
    )
    .map_err(failed)?;
    conn.execute(
        "DELETE FROM sync_history WHERE rowid NOT IN (
           SELECT rowid FROM sync_history ORDER BY created_at DESC, rowid DESC LIMIT ?1)",
        params![KEEP],
    )
    .map_err(failed)?;
    Ok(())
}

/// One page of rows, newest first, and the total: `sync_get_history`.
pub fn entries(
    conn: &Connection,
    limit: i64,
    offset: i64,
) -> Result<(Vec<HistoryEntry>, i64), StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, kind, item_count, direction, details, duration_ms, created_at
             FROM sync_history ORDER BY created_at DESC, rowid DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![limit, offset], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                kind: row.get(1)?,
                item_count: row.get(2)?,
                direction: row.get(3)?,
                details: row.get(4)?,
                duration_ms: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let total = conn
        .query_row("SELECT COUNT(*) FROM sync_history", [], |row| row.get(0))
        .map_err(failed)?;
    Ok((rows, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn history_keeps_the_newest_500_rows_newest_first() {
        let dir = temp_dir("sync-history");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|conn| {
            for at in 0..520 {
                record(conn, HistoryKind::Pull, 1, 5, None, at)?;
            }
            record(conn, HistoryKind::Error, 0, 7, Some("offline"), 1_000)?;
            let (page, total) = entries(conn, 3, 0)?;
            assert_eq!(total, KEEP);
            let created: Vec<i64> = page.iter().map(|row| row.created_at).collect();
            assert_eq!(created, [1_000, 519, 518]);
            assert_eq!(page[0].kind, "error");
            assert_eq!(page[0].direction, None);
            assert_eq!(page[0].details.as_deref(), Some("offline"));
            assert_eq!(page[1].direction.as_deref(), Some("pull"));
            let (oldest, _) = entries(conn, 1, KEEP - 1)?;
            assert_eq!(oldest[0].created_at, 21);
            assert_eq!(oldest[0].id.len(), 36);
            Ok(())
        })
        .expect("history");
    }
}
