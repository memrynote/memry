//! "This note's vault file holds a body its document has not taken" (desktop
//! `crdt-owed-file-body.ts`, #2646).
//!
//! An outside edit cannot be fed into a note whose server body has not been
//! pulled yet ([`super::external_feed`]): the replace would share no Yjs items
//! with the server body and push a second copy of the text (#2536). The note
//! owes its file body instead: this marker remembers that the file is ahead of
//! the document. While it stands, nothing may write the file from the document
//! (12e write-back), and the step that merges the server body applies the file on
//! top of it and clears the marker (Step 17, `takeOwedFile`).
//!
//! A feed this build refused records the marker too ([`super::external_feed::Refusal`]):
//! the file holds an edit the document did not take, the same "file is ahead". The take
//! is a feed, so a body this build cannot read whole stays refused, and the file stays
//! unwritten, until a build that can read it.
//!
//! One `meta` row per note, `vault.owed_file_body:<noteId>`, whose value is the
//! time it was first recorded (milliseconds). Device-local state that needs no
//! table, the way `sync.body_owed:<docId>` ([`crate::sync::body_debt`]) needs
//! none. An older build never reads the key. A lost marker costs one skipped
//! take, never a file: the file stays on disk.
//!
//! The consumer of the marker (Step 17) sweeps [`list`] when a body pull settles
//! and at startup, so a marker recorded just as the debt settled is still taken.
//!
//! A marker of a note deleted through sync stays until the note's file row goes
//! ([`super::note_files::remove`]). It is harmless meanwhile: [`list`] leaves out
//! a note that does not live, and nothing writes a deleted note's file.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

const PREFIX: &str = "vault.owed_file_body:";
/// The first key after every key with [`PREFIX`] (`:` is followed by `;`).
const PREFIX_END: &str = "vault.owed_file_body;";

fn key(note_id: &str) -> String {
    format!("{PREFIX}{note_id}")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Records that `note_id`'s file is ahead of its document. Idempotent: the first
/// time is kept.
pub fn record(conn: &Connection, note_id: &str, now_ms: i64) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
        params![key(note_id), now_ms.to_string()],
    )
    .map(|_| ())
    .map_err(failed)
}

pub fn owes(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)",
        params![key(note_id)],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Takes the marker back. True when there was one.
pub fn clear(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key(note_id)])
        .map(|n| n > 0)
        .map_err(failed)
}

/// Every note that owes its file body and is still live, in id order. A marker on
/// a deleted note is not listed: its body must not come back.
pub fn list(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT substr(meta.key, ?1) FROM meta
               JOIN notes ON notes.id = substr(meta.key, ?1) AND notes.deleted_at IS NULL
              WHERE meta.key >= ?2 AND meta.key < ?3
              ORDER BY meta.key",
        )
        .map_err(failed)?;
    statement
        .query_map(
            params![PREFIX.chars().count() as i64 + 1, PREFIX, PREFIX_END],
            |row| row.get(0),
        )
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn a_marker_is_kept_at_its_first_time_listed_while_the_note_lives_and_cleared() {
        let dir = temp_dir("owed-file-body");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            for id in ["b", "a"] {
                conn.execute(
                    "INSERT INTO notes (id, title, created_at, modified_at) VALUES (?1, ?1, 1, 1)",
                    params![id],
                )
                .map_err(failed)?;
            }
            record(conn, "b", 10)?;
            record(conn, "b", 99)?;
            record(conn, "a", 11)?;
            record(conn, "gone", 12)?;
            let first: String = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![key("b")],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            assert_eq!(first, "10");
            assert_eq!(
                list(conn)?,
                ["a", "b"],
                "a note that does not live is not listed"
            );
            assert!(owes(conn, "a")? && !owes(conn, "zzz")?);
            assert!(clear(conn, "a")? && !clear(conn, "a")?);
            assert_eq!(list(conn)?, ["b"]);
            Ok(())
        })
        .expect("markers");
    }
}
