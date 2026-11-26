//! Moves a `data.db` that an earlier feat/tauri-v2 build migrated onto the shipped numbering
//! (#4052).
//!
//! main shipped data migrations 13 `calendar_cursor_reset`, 14 `calendar_foreign_cursor_reset`,
//! 15 `saved_filter_expressions`, 16 `inbox_attachments`, 17 `search_recents` and 18
//! `note_attachment_uploads`. feat/tauri-v2's first ten own migrations now run as 19..28.
//! Earlier feat/tauri-v2 builds numbered them 13..22 (generation A, before #4052), then 15..24
//! (generation B, before main's 15 and 16 were merged), then 17..26 (generation C, before main's
//! 17 was merged, #4438), then 18..27 (generation D, before main's 18 was merged, #5221). Those
//! builds ran on test machines only, but their files must still open with every row, and they
//! never ran the main migrations their own numbers took.
//!
//! The counter alone cannot tell the numberings apart: a file at 20 can be any of them. The
//! schema can. A migration commits before its counter moves, so a generation whose own first
//! version is F holds `OWN_TABLES[V - F]` at V. The crash window of §A.0 adds at most the next
//! table. So at V a generation-A file (F = 13) holds `OWN_TABLES[V - 13]`, a generation-B file
//! (F = 15) holds at most `OWN_TABLES[V - 14]`, and a file of this numbering (F = 19) at most
//! `OWN_TABLES[V - 18]`. Generation A is checked first: a generation-A file also holds
//! generation B's table for its version, so the order decides. A renumbered file lands where
//! both checks read the table of a later migration, which it lacks, so a later open leaves the
//! file alone.
//!
//! Generations C and D own more migrations than `OWN_TABLES` lists, so their tables cannot place
//! a file past the tenth, and generation D is one step behind: old V's table belongs to new V + 1,
//! which a file at new V holds in its crash window. The main migration each one skipped can
//! (`SKIPPED`): a generation-C file at 17 or later holds `note_snapshots` and neither
//! `search_recents` nor `note_attachment_uploads`; a generation-D file at 18 or later holds
//! `note_snapshots` and `search_recents` but not `note_attachment_uploads`. Every file of this
//! numbering past 16 holds `search_recents`, past 17 `note_attachment_uploads`, and generations
//! A and B are matched first. A file main took to 18 that a generation-D build then opened ran
//! that build's own migrations from its 19 and never `note_snapshots`: past 18 it holds
//! `note_attachment_uploads` and `local_settings` without `note_snapshots`, which no other
//! numbering leaves, so it moves up one and runs `note_snapshots`. Those checks hold only because no migration ever drops
//! `search_recents`, `note_attachment_uploads` or `note_snapshots`.
//!
//! The next clash: main keeps its number and feat/tauri-v2 shifts its own above it in the merge
//! (#4438, #5221). `OWN_FIRST` moves up, each `GENERATIONS` range of missed migrations grows to
//! end below it, and the main migration the previous numbering skipped joins `SKIPPED`, as
//! generation D's did.

use std::ops::RangeInclusive;

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
const OWN_FIRST: u32 = 19;

/// Generations C and D, oldest first: the main migration whose number each one gave
/// `OWN_TABLES[0]`, and the table only that migration creates. Such a file never ran that
/// migration or any later main one (see the module comment).
const SKIPPED: [(u32, &str); 2] = [(17, "search_recents"), (18, "note_attachment_uploads")];

/// An earlier numbering: the version it gave `OWN_TABLES[0]`, and the main migrations it never
/// ran, by version.
struct Generation {
    first: u32,
    missed: RangeInclusive<u32>,
}

/// Checked in this order (see the module comment).
const GENERATIONS: [Generation; 2] = [
    Generation {
        first: 13,
        missed: 13..=18,
    },
    Generation {
        first: 15,
        missed: 15..=18,
    },
];

impl Generation {
    fn shift(&self) -> u32 {
        OWN_FIRST - self.first
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
    if move_of(conn, user_version(conn)?)?.is_none() {
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
    let Some((shift, missed_versions)) = move_of(&tx, version)? else {
        return Ok(());
    };
    let target = version + shift;
    let fail = |err: rusqlite::Error| StorageError::Migration {
        version: target,
        what: format!("renumbering a data.db an earlier desktop build left at {version}: {err}"),
    };
    for migration in missed(&missed_versions) {
        tx.execute_batch(migration.sql).map_err(fail)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {target}"))
        .map_err(fail)?;
    tx.commit().map_err(fail)
}

/// main's migrations an earlier numbering never ran. Every one is idempotent.
fn missed(versions: &RangeInclusive<u32>) -> impl Iterator<Item = &'static Migration> + '_ {
    DATA_MIGRATIONS
        .iter()
        .filter(|m| versions.contains(&m.version))
}

/// How far a file at `version` moves and which of main's migrations it runs on the way, when an
/// earlier numbering left it.
fn move_of(
    conn: &Connection,
    version: u32,
) -> Result<Option<(u32, RangeInclusive<u32>)>, StorageError> {
    if let Some(generation) = generation_of(conn, version)? {
        return Ok(Some((generation.shift(), generation.missed.clone())));
    }
    if !has_table(conn, OWN_TABLES[0])? {
        // main took the file to 18, then a generation-D build took 18 for its own
        // `note_snapshots` and ran the rest from 19: one short, without `note_snapshots`.
        let (main_last, main_table) = SKIPPED[1];
        if version >= OWN_FIRST && has_table(conn, main_table)? && has_table(conn, OWN_TABLES[1])? {
            return Ok(Some((OWN_FIRST - main_last, OWN_FIRST..=OWN_FIRST)));
        }
        return Ok(None);
    }
    for (first, table) in SKIPPED {
        if version >= first && !has_table(conn, table)? {
            return Ok(Some((OWN_FIRST - first, first..=OWN_FIRST - 1)));
        }
    }
    Ok(None)
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
            .map(|g| missed(&g.missed).map(|m| (m.version, m.name)).collect())
            .collect();
        assert_eq!(
            missed,
            [
                vec![
                    (13, "calendar_cursor_reset"),
                    (14, "calendar_foreign_cursor_reset"),
                    (15, "saved_filter_expressions"),
                    (16, "inbox_attachments"),
                    (17, "search_recents"),
                    (18, "note_attachment_uploads"),
                ],
                vec![
                    (15, "saved_filter_expressions"),
                    (16, "inbox_attachments"),
                    (17, "search_recents"),
                    (18, "note_attachment_uploads"),
                ],
            ]
        );
        for (version, table) in SKIPPED {
            let creates = format!("CREATE TABLE IF NOT EXISTS {table} ");
            let creators: Vec<_> = DATA_MIGRATIONS
                .iter()
                .filter(|m| m.sql.contains(&creates))
                .map(|m| m.version)
                .collect();
            assert_eq!(creators, [version], "{table}");
        }
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
