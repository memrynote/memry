//! Moves a `data.db` that an earlier feat/tauri-v2 build migrated onto the shipped numbering
//! (#4052).
//!
//! main shipped data migrations 13 `calendar_cursor_reset` and 14
//! `calendar_foreign_cursor_reset`. feat/tauri-v2 builds had used 13..22 for their own
//! migrations, which now run as 15..24. Those builds ran on test machines only, but their files
//! must still open with every row, and they never ran main's two cursor resets.
//!
//! The counter alone cannot tell the numberings apart: a file at 17 can be either. The schema
//! can. A migration commits before its counter moves, so under the old numbering the table that
//! old migration V created exists at V. Under this numbering that table belongs to migration
//! V + 2, and the crash window of §A.0 leaves at most V + 1 committed past the counter, so the
//! table is absent. A renumbered file sits at V + 2, whose old table belongs to migration V + 4
//! here and is absent too, so a later open leaves the file alone.
//!
//! The next clash: merge main into feat/tauri-v2 before main ships another data migration.
//! This check reads only a shift of two. A one-step shift cannot be told apart by the schema:
//! old V's table belongs to new V + 1, which a file at new V holds in its crash window, so it
//! needs an explicit marker that the shifted build writes. A second shift needs its own
//! `OLD_TABLES` set.

use rusqlite::{Connection, TransactionBehavior};

use super::{DATA_MIGRATIONS, user_version};
use crate::api::errors::StorageError;

/// For each old version, the table only that old migration created.
const OLD_TABLES: [(u32, &str); 10] = [
    (13, "note_snapshots"),
    (14, "local_settings"),
    (15, "note_files"),
    (16, "note_positions"),
    (17, "note_file_hashes"),
    (18, "note_place_owed"),
    (19, "wiki_name_keys"),
    (20, "vault_locks"),
    (21, "note_large_files"),
    (22, "note_file_marks"),
];

/// main's 13 and 14, which the old numbering never ran. Both are idempotent cursor resets.
fn missed() -> &'static [super::Migration] {
    &DATA_MIGRATIONS[12..14]
}

/// Renumbers the file when it is on the old numbering; otherwise does nothing.
///
/// The reset and the new counter commit in one transaction, so a crash leaves the file on one
/// numbering or the other. The transaction takes the write lock before it reads the counter
/// again, so a second process that opened the file at the same time sees the renumbered file.
pub(super) fn renumber(conn: &mut Connection) -> Result<(), StorageError> {
    if !on_old_numbering(conn, user_version(conn)?)? {
        return Ok(());
    }
    let version = user_version(conn)?;
    let fail = |err: rusqlite::Error| StorageError::Migration {
        version: version + 2,
        what: format!("renumbering a data.db an earlier desktop build left at {version}: {err}"),
    };
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    let version = user_version(&tx)?;
    if !on_old_numbering(&tx, version)? {
        return Ok(());
    }
    for migration in missed() {
        tx.execute_batch(migration.sql).map_err(fail)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {}", version + 2))
        .map_err(fail)?;
    tx.commit().map_err(fail)
}

/// Whether the file is at an old version and holds that version's old table. Such a file must
/// hold every earlier old table too, because each old migration committed before the next ran.
/// One that lacks any did not come from an earlier build, so it is refused, not renumbered.
fn on_old_numbering(conn: &Connection, version: u32) -> Result<bool, StorageError> {
    let Some((_, table)) = OLD_TABLES.iter().find(|(old, _)| *old == version) else {
        return Ok(false);
    };
    if !has_table(conn, table)? {
        return Ok(false);
    }
    for (old, table) in OLD_TABLES.iter().filter(|(old, _)| *old < version) {
        if !has_table(conn, table)? {
            return Err(StorageError::Migration {
                version: version + 2,
                what: format!(
                    "data.db at {version} holds the earlier desktop numbering's tables but not \
                     {table} (its migration {old}), so it is not renumbered"
                ),
            });
        }
    }
    Ok(true)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|err| StorageError::Failed {
        what: format!("could not read the data.db schema: {err}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reset this module runs is main's 13 and 14, and each old table is created by the
    /// migration two versions later here, by no other.
    #[test]
    fn the_old_tables_and_the_missed_migrations_match_the_list() {
        let names: Vec<_> = missed().iter().map(|m| (m.version, m.name)).collect();
        assert_eq!(
            names,
            [
                (13, "calendar_cursor_reset"),
                (14, "calendar_foreign_cursor_reset")
            ]
        );
        for (old, table) in OLD_TABLES {
            let creates = format!("CREATE TABLE IF NOT EXISTS {table} ");
            let creators: Vec<_> = DATA_MIGRATIONS
                .iter()
                .filter(|m| m.sql.contains(&creates))
                .map(|m| m.version)
                .collect();
            assert_eq!(creators, [old + 2], "{table}");
        }
    }
}
