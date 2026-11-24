//! The `PRAGMA user_version` migration runner (data-model §A.0).
//!
//! Hand written, forward only, never dropping a column. A removed concept leaves
//! its column in place unread, because a rollback to an older build must still
//! open the file. There is no migrations table, because a migrations table
//! itself eventually needs migrating.
//!
//! §A.0 states the convention, and it is easy to get subtly wrong. Each pending
//! migration runs in **one** `BEGIN IMMEDIATE` transaction that takes the write
//! lock, reads `user_version` again, skips the migration when another connection
//! already took the file to it or past it, and otherwise runs the statements and
//! sets `user_version` to the migration's number before it commits. Two
//! processes can open one file at once (the desktop app and the CLI): the second
//! waits on the busy timeout for the first one's transaction, then sees its
//! counter, so every migration applies once and the counter never moves back.
//! The two databases carry independent counters, which is why [`run`] takes the
//! migration list rather than reading a global.
//!
//! **Why the DDL is written `IF NOT EXISTS`.** Builds before this runner set the
//! counter outside the transaction, after it committed. A crash in that window
//! left a file whose objects exist at the older version, and this runner applies
//! that migration again. `IF NOT EXISTS` makes that re-run a clean no-op that then
//! sets the counter; without it, such a file could never migrate again.

use rusqlite::{Connection, TransactionBehavior};

use crate::api::errors::StorageError;
use crate::storage::repositories::sync_items;

/// One hand-written, forward-only step.
pub struct Migration {
    /// The value `user_version` takes once this migration has committed.
    /// Strictly ascending across a list, starting at 1.
    pub version: u32,
    /// For error messages and logs only. Never read as an identity.
    pub name: &'static str,
    /// The statements, run as one batch inside one transaction.
    pub sql: &'static str,
}

/// `data.db`: source of record, then the typed projections over it.
pub const DATA_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline",
        sql: include_str!("migrations/data/0001_baseline.sql"),
    },
    Migration {
        version: 2,
        name: "projections",
        sql: include_str!("migrations/data/0002_projections.sql"),
    },
    Migration {
        version: 3,
        name: "saved_filters",
        sql: include_str!("migrations/data/0003_saved_filters.sql"),
    },
    Migration {
        version: 4,
        name: "inbox",
        sql: include_str!("migrations/data/0004_inbox.sql"),
    },
    Migration {
        version: 5,
        name: "tombstone_clocks",
        sql: include_str!("migrations/data/0005_tombstone_clocks.sql"),
    },
    // Spec 007 calendar: after main's 0005, so an install that already ran
    // 0005 still receives these.
    Migration {
        version: 6,
        name: "calendar",
        sql: include_str!("migrations/data/0006_calendar.sql"),
    },
    Migration {
        version: 7,
        name: "calendar_source_states",
        sql: include_str!("migrations/data/0007_calendar_source_states.sql"),
    },
    Migration {
        version: 8,
        name: "calendar_push_queue",
        sql: include_str!("migrations/data/0008_calendar_push_queue.sql"),
    },
    Migration {
        version: 9,
        name: "bookmarks",
        sql: include_str!("migrations/data/0009_bookmarks.sql"),
    },
    Migration {
        version: 10,
        name: "note_body_tags",
        sql: include_str!("migrations/data/0010_note_body_tags.sql"),
    },
    Migration {
        version: 11,
        name: "yjs_doc_epochs",
        sql: include_str!("migrations/data/0011_yjs_doc_epochs.sql"),
    },
    Migration {
        version: 12,
        name: "journal_aliases",
        sql: include_str!("migrations/data/0012_journal_aliases.sql"),
    },
    // main's 13..18, shipped in v2026-11-05.2 and later (18 in v2026-11-23).
    // feat/tauri-v2 builds had used 13..22, then 15..24, then 17..28, then
    // 18..38, for the entries from 19 on; `legacy_numbering` moves a file of
    // any of them onto this numbering (#4052, #4438, #5221).
    Migration {
        version: 13,
        name: "calendar_cursor_reset",
        sql: include_str!("migrations/data/0013_calendar_cursor_reset.sql"),
    },
    Migration {
        version: 14,
        name: "calendar_foreign_cursor_reset",
        sql: include_str!("migrations/data/0014_calendar_foreign_cursor_reset.sql"),
    },
    Migration {
        version: 15,
        name: "saved_filter_expressions",
        sql: include_str!("migrations/data/0015_saved_filter_expressions.sql"),
    },
    Migration {
        version: 16,
        name: "inbox_attachments",
        sql: include_str!("migrations/data/0016_inbox_attachments.sql"),
    },
    Migration {
        version: 17,
        name: "search_recents",
        sql: include_str!("migrations/data/0017_search_recents.sql"),
    },
    Migration {
        version: 18,
        name: "note_attachment_uploads",
        sql: include_str!("migrations/data/0018_note_attachment_uploads.sql"),
    },
    // feat/tauri-v2's own, shifted one up in the main -> feat/tauri-v2 merge of #5221 so
    // main's shipped 18 keeps its number; `legacy_numbering` moves a file a build before that
    // merge left (own migrations from 18) onto this numbering.
    Migration {
        version: 19,
        name: "note_snapshots",
        sql: include_str!("migrations/data/0019_note_snapshots.sql"),
    },
    Migration {
        version: 20,
        name: "local_settings",
        sql: include_str!("migrations/data/0020_local_settings.sql"),
    },
    Migration {
        version: 21,
        name: "note_files",
        sql: include_str!("migrations/data/0021_note_files.sql"),
    },
    Migration {
        version: 22,
        name: "notes_device_tables",
        sql: include_str!("migrations/data/0022_notes_device_tables.sql"),
    },
    Migration {
        version: 23,
        name: "note_file_hashes",
        sql: include_str!("migrations/data/0023_note_file_hashes.sql"),
    },
    Migration {
        version: 24,
        name: "note_identity",
        sql: include_str!("migrations/data/0024_note_identity.sql"),
    },
    Migration {
        version: 25,
        name: "wiki_name_keys",
        sql: include_str!("migrations/data/0025_wiki_name_keys.sql"),
    },
    Migration {
        version: 26,
        name: "vault_locks",
        sql: include_str!("migrations/data/0026_vault_locks.sql"),
    },
    Migration {
        version: 27,
        name: "note_large_files",
        sql: include_str!("migrations/data/0027_note_large_files.sql"),
    },
    Migration {
        version: 28,
        name: "note_file_marks",
        sql: include_str!("migrations/data/0028_note_file_marks.sql"),
    },
    Migration {
        version: 29,
        name: "desktop_record_types",
        sql: include_str!("migrations/data/0029_desktop_record_types.sql"),
    },
    Migration {
        version: 30,
        name: "agent_records",
        sql: include_str!("migrations/data/0030_agent_records.sql"),
    },
    // 31 follows the main -> feat/tauri-v2 shifts: main's #4419 keeps data
    // 0017, and feat's own 0017-0028 (28 is #4456's agent records) moved to
    // 0018-0029 (#4438); main's #5526 keeps 0018, and they moved on to
    // 0019-0030 (#5221). 31 must not land before 29 and 30: the runner
    // applies only `version > user_version`.
    Migration {
        version: 31,
        name: "sync_refused_items",
        sql: include_str!("migrations/data/0031_sync_refused_items.sql"),
    },
    Migration {
        version: 32,
        name: "sync_hardening",
        sql: include_str!("migrations/data/0032_sync_hardening.sql"),
    },
    Migration {
        version: 33,
        name: "note_body_sync",
        sql: include_str!("migrations/data/0033_note_body_sync.sql"),
    },
    Migration {
        version: 34,
        name: "inbox_jobs",
        sql: include_str!("migrations/data/0034_inbox_jobs.sql"),
    },
    Migration {
        version: 35,
        name: "attachment_sync",
        sql: include_str!("migrations/data/0035_attachment_sync.sql"),
    },
    Migration {
        version: 36,
        name: "recents",
        sql: include_str!("migrations/data/0036_recents.sql"),
    },
    Migration {
        version: 37,
        name: "canvases",
        sql: include_str!("migrations/data/0037_canvases.sql"),
    },
    Migration {
        version: 38,
        name: "task_links",
        sql: include_str!("migrations/data/0038_task_links.sql"),
    },
    Migration {
        version: 39,
        name: "readwise",
        sql: include_str!("migrations/data/0039_readwise.sql"),
    },
];

/// `index.db`: the rebuildable search and link index.
///
/// An `index.db` at a lower version migrates in place through this list and
/// keeps every row; only a damaged file, or one written by a newer build, is
/// deleted and rebuilt (`index_db`). So an entry is hand written, additive and
/// idempotent (`IF NOT EXISTS`), exactly like a `data.db` migration.
pub const INDEX_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "fts",
        sql: include_str!("migrations/index/0001_fts.sql"),
    },
    Migration {
        version: 2,
        name: "link_target_keys",
        sql: include_str!("migrations/index/0002_link_target_keys.sql"),
    },
    Migration {
        version: 3,
        name: "fts_inbox",
        sql: include_str!("migrations/index/0003_fts_inbox.sql"),
    },
    Migration {
        version: 4,
        name: "note_stats",
        sql: include_str!("migrations/index/0004_note_stats.sql"),
    },
    Migration {
        version: 5,
        name: "note_stats_header_read",
        sql: include_str!("migrations/index/0005_note_stats_header_read.sql"),
    },
    Migration {
        version: 6,
        name: "note_fold_chunks",
        sql: include_str!("migrations/index/0006_note_fold_chunks.sql"),
    },
    Migration {
        version: 7,
        name: "block_refs",
        sql: include_str!("migrations/index/0007_block_refs.sql"),
    },
    Migration {
        version: 8,
        name: "embedding_state",
        sql: include_str!("migrations/index/0008_embedding_state.sql"),
    },
    Migration {
        version: 9,
        name: "property_refs",
        sql: include_str!("migrations/index/0009_property_refs.sql"),
    },
    Migration {
        version: 10,
        name: "file_text",
        sql: include_str!("migrations/index/0010_file_text.sql"),
    },
    Migration {
        version: 11,
        name: "note_embedding_hashes",
        sql: include_str!("migrations/index/0011_note_embedding_hashes.sql"),
    },
    Migration {
        version: 12,
        name: "canvas_refs",
        sql: include_str!("migrations/index/0012_canvas_refs.sql"),
    },
];

/// `vectors.db`: the semantic-search cache. Unlike `index.db` it migrates
/// forward like `data.db`, so a schema bump never throws away hours of
/// embedding; every entry is additive so an older build still reads the file.
pub const VECTOR_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "note_vectors",
        sql: include_str!("migrations/vectors/0001_note_vectors.sql"),
    },
    Migration {
        version: 2,
        name: "note_embed_attempts",
        sql: include_str!("migrations/vectors/0002_note_embed_attempts.sql"),
    },
];

/// The version a fully migrated database sits at. Zero for an empty list.
pub fn latest_version(migrations: &[Migration]) -> u32 {
    migrations.last().map_or(0, |migration| migration.version)
}

/// Reads `PRAGMA user_version`.
pub fn user_version(conn: &Connection) -> Result<u32, StorageError> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map(|version| version as u32)
        .map_err(|err| StorageError::Failed {
            what: format!("could not read user_version: {err}"),
        })
}

/// Migrates `data.db`, as every open of the file does: moves a file an earlier
/// feat/tauri-v2 build left onto this numbering ([`legacy_numbering`]), applies
/// [`DATA_MIGRATIONS`], then projects the stored payloads a projection table
/// does not reflect yet ([`sync_items::heal_projections`]). That runs after the
/// last migration, with the projector of this build, so a projector written
/// for a later schema never runs against an earlier one.
pub fn run_data(conn: &mut Connection) -> Result<u32, StorageError> {
    legacy_numbering::renumber(conn)?;
    let version = run(conn, DATA_MIGRATIONS)?;
    sync_items::heal_projections(conn)?;
    Ok(version)
}

/// Applies every migration newer than the database's `user_version`, in order,
/// and returns the version it ends at.
///
/// A database already at or past the last version is left untouched, so calling
/// this on every open is the intended use.
pub fn run(conn: &mut Connection, migrations: &[Migration]) -> Result<u32, StorageError> {
    run_atomic(conn, migrations).map_err(StorageError::from)
}

/// A migration that failed, with the SQLite error that stopped it, so the caller
/// can tell a defect in the migration from a lock or a full disk.
#[derive(Debug)]
pub struct MigrationFailure {
    pub version: u32,
    pub name: &'static str,
    pub error: rusqlite::Error,
}

impl From<MigrationFailure> for StorageError {
    fn from(failure: MigrationFailure) -> Self {
        Self::Migration {
            version: failure.version,
            what: format!("{}: {}", failure.name, failure.error),
        }
    }
}

/// As [`run`], with the failed migration's SQLite error kept for the caller
/// (`index_db` rebuilds on a defect and not on a lock).
pub fn run_atomic(
    conn: &mut Connection,
    migrations: &[Migration],
) -> Result<u32, MigrationFailure> {
    let read = |conn: &Connection| {
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map(|version| version as u32)
    };
    let mut current = read(conn).map_err(|error| MigrationFailure {
        version: 0,
        name: "read user_version",
        error,
    })?;
    for migration in migrations {
        if migration.version <= current {
            continue;
        }
        let fail = |error| MigrationFailure {
            version: migration.version,
            name: migration.name,
            error,
        };
        // The write lock before the counter is read: a second connection
        // migrating the same file waits here, then sees how far the first got.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(fail)?;
        current = read(&tx).map_err(fail)?;
        if migration.version <= current {
            continue;
        }
        tx.execute_batch(migration.sql).map_err(fail)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", migration.version))
            .map_err(fail)?;
        tx.commit().map_err(fail)?;
        current = migration.version;
    }
    Ok(current)
}

#[cfg(test)]
mod agent_records_tests;
#[cfg(test)]
mod attachment_sync_tests;
#[cfg(test)]
mod canvases_tests;
#[cfg(test)]
mod concurrent_open_tests;
#[cfg(test)]
mod desktop_record_types_tests;
#[cfg(test)]
mod file_text_tests;
mod legacy_numbering;
#[cfg(test)]
mod note_file_marks_tests;
#[cfg(test)]
mod note_large_files_tests;
#[cfg(test)]
mod numbering_tests;
#[cfg(test)]
mod readwise_tests;
#[cfg(test)]
mod saved_filter_inbox_tests;
#[cfg(test)]
mod sequence_tests;
#[cfg(test)]
mod step_forward_tests;
#[cfg(test)]
mod task_links_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod wiki_names_tests;
