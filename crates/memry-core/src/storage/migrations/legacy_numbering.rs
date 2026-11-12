//! Moves a `data.db` that an earlier feat/tauri-v2 build migrated onto the shipped numbering
//! (#4052).
//!
//! main shipped data migrations 13 `calendar_cursor_reset`, 14 `calendar_foreign_cursor_reset`,
//! 15 `saved_filter_expressions` and 16 `inbox_attachments`. feat/tauri-v2's own ten migrations
//! now run as 17..26. Earlier feat/tauri-v2 builds numbered them 13..22 (generation A, before
//! #4052), then 15..24 (generation B, before main's 15 and 16 were merged). Those builds ran on
//! test machines only, but their files must still open with every row, and they never ran the
//! main migrations their own numbers took.
//!
//! The counter alone cannot tell the numberings apart: a file at 19 can be any of them. The
//! schema can. A migration commits before its counter moves, so a generation whose own first
//! version is F holds `OWN_TABLES[V - F]` at V. The crash window of §A.0 adds at most the next
//! table. So at V a generation-A file (F = 13) holds `OWN_TABLES[V - 13]`, a generation-B file
//! (F = 15) holds at most `OWN_TABLES[V - 14]`, and a file of this numbering (F = 17) at most
//! `OWN_TABLES[V - 16]`. Generation A is checked first: a generation-A file also holds
//! generation B's table for its version, so the order decides. A renumbered file lands where
//! both checks read the table of a later migration, which it lacks, so a later open leaves the
//! file alone.
//!
//! The next clash: merge main into feat/tauri-v2 before main ships another data migration.
//! A shift of two or more needs one more `GENERATIONS` entry. A one-step shift cannot be told
//! apart by the schema: old V's table belongs to new V + 1, which a file at new V holds in its
//! crash window, so it needs an explicit marker that the shifted build writes.

use rusqlite::{Connection, TransactionBehavior};

use super::{DATA_MIGRATIONS, Migration, user_version};
use crate::api::errors::StorageError;

/// feat/tauri-v2's own migrations in order, each by the table only it creates.
const OWN_TABLES: [&str; 10] = [
    "note_snapshots",
    "local_settings",
    "note_files",
    "note_positions",
    "note_file_hashes",
    "note_place_owed",
    "wiki_name_keys",
    "vault_locks",
    "note_large_files",
    "note_file_marks",
];

/// The version this numbering gives `OWN_TABLES[0]`.
const OWN_FIRST: u32 = 17;

/// An earlier numbering: the version it gave `OWN_TABLES[0]`, and the main migrations it never
/// ran, by version.
struct Generation {
    first: u32,
    missed: std::ops::RangeInclusive<u32>,
}

/// Checked in this order (see the module comment).
const GENERATIONS: [Generation; 2] = [
    Generation {
        first: 13,
        missed: 13..=16,
    },
    Generation {
        first: 15,
        missed: 15..=16,
    },
];

impl Generation {
    fn shift(&self) -> u32 {
        OWN_FIRST - self.first
    }

    /// main's migrations this numbering never ran. Every one is idempotent.
    fn missed(&self) -> impl Iterator<Item = &'static Migration> + '_ {
        DATA_MIGRATIONS
            .iter()
            .filter(|m| self.missed.contains(&m.version))
    }

    /// The table only this generation's migration `version` created.
    fn table_at(&self, version: u32) -> Option<&'static str> {
        let index = version.checked_sub(self.first)?;
        OWN_TABLES.get(usize::try_from(index).ok()?).copied()
    }
}

/// Renumbers the file when it is on an earlier numbering; otherwise does nothing.
///
/// The missed migrations and the new counter commit in one transaction, so a crash leaves the
/// file on one numbering or the other. The transaction takes the write lock before it reads the
/// counter again, so a second process that opened the file at the same time sees the renumbered
/// file.
pub(super) fn renumber(conn: &mut Connection) -> Result<(), StorageError> {
    if generation_of(conn, user_version(conn)?)?.is_none() {
        return Ok(());
    }
    let version = user_version(conn)?;
    let fail = |err: rusqlite::Error| StorageError::Migration {
        version,
        what: format!("renumbering a data.db an earlier desktop build left at {version}: {err}"),
    };
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    let version = user_version(&tx)?;
    let Some(generation) = generation_of(&tx, version)? else {
        return Ok(());
    };
    let target = version + generation.shift();
    let fail = |err: rusqlite::Error| StorageError::Migration {
        version: target,
        what: format!("renumbering a data.db an earlier desktop build left at {version}: {err}"),
    };
    for migration in generation.missed() {
        tx.execute_batch(migration.sql).map_err(fail)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {target}"))
        .map_err(fail)?;
    tx.commit().map_err(fail)
}

/// The earlier generation whose table for `version` the file holds, if any. Such a file must
/// hold every earlier table of that generation too, because each migration committed before
/// the next ran. One that lacks any did not come from an earlier build, so it is refused, not
/// renumbered.
fn generation_of(
    conn: &Connection,
    version: u32,
) -> Result<Option<&'static Generation>, StorageError> {
    for generation in &GENERATIONS {
        let Some(table) = generation.table_at(version) else {
            continue;
        };
        if !has_table(conn, table)? {
            continue;
        }
        for old in generation.first..version {
            let Some(earlier) = generation.table_at(old) else {
                continue;
            };
            if !has_table(conn, earlier)? {
                return Err(StorageError::Migration {
                    version: version + generation.shift(),
                    what: format!(
                        "data.db at {version} holds an earlier desktop numbering's tables but not \
                         {earlier} (its migration {old}), so it is not renumbered"
                    ),
                });
            }
        }
        return Ok(Some(generation));
    }
    Ok(None)
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

    /// Each generation misses exactly main's migrations its numbers took, and each own table is
    /// created by one migration only, the one this numbering puts at `OWN_FIRST` + its index.
    #[test]
    fn the_own_tables_and_the_missed_migrations_match_the_list() {
        let missed: Vec<Vec<_>> = GENERATIONS
            .iter()
            .map(|g| g.missed().map(|m| (m.version, m.name)).collect())
            .collect();
        assert_eq!(
            missed,
            [
                vec![
                    (13, "calendar_cursor_reset"),
                    (14, "calendar_foreign_cursor_reset"),
                    (15, "saved_filter_expressions"),
                    (16, "inbox_attachments"),
                ],
                vec![(15, "saved_filter_expressions"), (16, "inbox_attachments"),],
            ]
        );
        for (index, table) in (0u32..).zip(OWN_TABLES) {
            let creates = format!("CREATE TABLE IF NOT EXISTS {table} ");
            let creators: Vec<_> = DATA_MIGRATIONS
                .iter()
                .filter(|m| m.sql.contains(&creates))
                .map(|m| m.version)
                .collect();
            assert_eq!(creators, [OWN_FIRST + index], "{table}");
        }
    }
}
