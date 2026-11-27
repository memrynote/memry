//! "This note's vault file owes its record's `aliases`" (#5825, #5828): the record was newer
//! than its file when the file was first named, or the file had no `aliases` key while the
//! record had names ([`super::notes::take_matched_file_aliases`]), so the record kept its list
//! and the desktop write-back owes the file its `aliases` key alone.
//!
//! The debt outlives a restart and holds before the write-back ran: while it stands, the list
//! the file had at adoption (`stale`) is not an answer. An outside edit that leaves the file's
//! list as it was (a body edit) keeps the record's names; one that changes it is the user's
//! answer, which clears the debt ([`super::notes::take_edited_file_aliases`]). The write-back
//! clears it once the file holds the record's list, and the open reconcile schedules every
//! debt ([`list`]), so a debt recorded just before a quit is still paid.
//!
//! One `meta` row per note, `vault.owed_file_aliases:<noteId>`, whose value is the JSON of the
//! file's list at adoption (`null` for no `aliases` key), next to the owed file body
//! ([`super::owed_file_body`]) and with the same lifetime: device-local, never synced, no
//! table, and it goes with the note's row ([`super::note_files::remove`]). An older build never
//! reads the key; a lost one costs the stale-list protection, never a file.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

const PREFIX: &str = "vault.owed_file_aliases:";
/// The first key after every key with [`PREFIX`] (`:` is followed by `;`).
const PREFIX_END: &str = "vault.owed_file_aliases;";

fn key(note_id: &str) -> String {
    format!("{PREFIX}{note_id}")
}

fn failed(error: impl ToString) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Records that `note_id`'s file owes the record's aliases, the file holding `stale`
/// (`None` for no `aliases` key). A debt already recorded keeps its first list: the file has
/// held it since.
pub fn record(
    conn: &Connection,
    note_id: &str,
    stale: Option<&[String]>,
) -> Result<(), StorageError> {
    let value = serde_json::to_string(&stale).map_err(failed)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
        params![key(note_id), value],
    )
    .map(drop)
    .map_err(failed)
}

/// The list the file held when the debt was recorded: `None` without a debt, `Some(None)` for a
/// file that had no `aliases` key. A value that does not read is a file with no key, so an
/// outside edit that adds one is still taken.
pub fn stale(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<Option<Vec<String>>>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key(note_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(value.map(|value| serde_json::from_str(&value).unwrap_or(None)))
}

pub fn owes(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    Ok(stale(conn, note_id)?.is_some())
}

/// Takes the debt back. True when there was one.
pub fn clear(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key(note_id)])
        .map(|n| n > 0)
        .map_err(failed)
}

/// Every note or journal day that owes its file its aliases, in id order.
pub fn list(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT substr(key, ?1) FROM meta WHERE key >= ?2 AND key < ?3 ORDER BY key")
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
    fn a_debt_keeps_its_first_list_tells_a_keyless_file_and_is_cleared() {
        let dir = temp_dir("owed-file-aliases");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            record(conn, "b", Some(&["Old".to_owned()]))?;
            record(conn, "b", Some(&["Other".to_owned()]))?;
            record(conn, "a", None)?;
            assert_eq!(stale(conn, "b")?, Some(Some(vec!["Old".to_owned()])));
            assert_eq!(stale(conn, "a")?, Some(None));
            assert_eq!(stale(conn, "zzz")?, None);
            assert_eq!(list(conn)?, ["a", "b"]);
            assert!(clear(conn, "a")? && !clear(conn, "a")?);
            assert!(!owes(conn, "a")? && owes(conn, "b")?);
            Ok(())
        })
        .expect("debts");
    }
}
