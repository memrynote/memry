//! The documents this device owes a per-note body pull (chapter 05 §5.11,
//! chapter 07 §7.13.2, §7.17.4; #2294, #2297).
//!
//! One `meta` row per document, `sync.body_owed:<docId>`, whose value is
//! `<failures>:<passes to wait>`. A row is written **before** the record
//! cursor moves past the page that created the debt, and deleted only after a
//! [`super::body_pull::BodyPull`] of that document reached the end of the
//! server's log and stored all of it, or when the document is tombstoned.
//!
//! **Settled means "in the log", not "in a resident document".** A settled
//! debt says this device's update log holds every server update up to the
//! head the pull saw. A document already open in memory merges those rows on
//! its next load; the snapshot push checks that separately
//! ([`crate::crdt::SnapshotPusher::push`]).
//!
//! Two readers depend on the debt:
//!
//! - **The pass's body step** pulls the due documents.
//!   A page re-pulled after a crash skips its identical records (chapter 06
//!   §6.5.2 P4), so the debt, not a re-apply, is what makes the body pull
//!   happen again.
//! - **[`crate::crdt::SnapshotPusher::push`] refuses an owed document**
//!   (§7.13.2 condition 1): a snapshot prunes the server's updates at or below
//!   its watermark, and this device does not hold them yet.
//!
//! A document whose pull keeps failing waits `2^(failures - 1)` passes, up to
//! [`MAX_WAIT_PASSES`], before it is pulled again, so one broken document does
//! not cost a request on every pass.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::apply::{DOCUMENT_TYPES, Pending};
use super::store::BARE_TOMBSTONE_ITEM_TYPE;

const OWED_PREFIX: &str = "sync.body_owed:";

/// The longest a failing document waits between pulls, in passes.
pub const MAX_WAIT_PASSES: u32 = 32;

fn key(doc_id: &str) -> String {
    format!("{OWED_PREFIX}{doc_id}")
}

/// `<failures>:<wait>`. Anything else (an older `'1'`) reads as `0:0`.
fn parse(value: &str) -> Backoff {
    value
        .split_once(':')
        .and_then(|(failures, wait)| Some((failures.parse().ok()?, wait.parse().ok()?)))
        .unwrap_or((0, 0))
}

fn write(conn: &Connection, doc_id: &str, failures: u32, wait: u32) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key(doc_id), format!("{failures}:{wait}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// Records that `doc_id` is owed a body pull. Idempotent: an existing debt
/// keeps its failure count.
pub fn owe(conn: &Connection, doc_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, '0:0') ON CONFLICT(key) DO NOTHING",
        params![key(doc_id)],
    )
    .map_err(failed)?;
    Ok(())
}

/// Keeps the debt after a pull that failed or stopped, and makes the document
/// wait before the next attempt.
pub fn owe_after_failure(conn: &Connection, doc_id: &str) -> Result<(), StorageError> {
    let stored = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key(doc_id)],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(failed)?;
    let failures = stored.as_deref().map_or(0, |value| parse(value).0) + 1;
    let wait = 1u32
        .checked_shl(failures - 1)
        .unwrap_or(MAX_WAIT_PASSES)
        .min(MAX_WAIT_PASSES);
    write(conn, doc_id, failures, wait)
}

/// Clears the debt: after a pull that reached the end of the server's log and
/// stored it all, or when the document is tombstoned.
pub fn settle(conn: &Connection, doc_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", params![key(doc_id)])
        .map_err(failed)?;
    Ok(())
}

pub fn is_owed(conn: &Connection, doc_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)",
        params![key(doc_id)],
        |row| row.get::<_, bool>(0),
    )
    .map_err(failed)
}

/// Every owed document that is still live, in id order. A debt on a
/// tombstoned document is settled here: its body must not come back (§7.15).
pub fn owed(conn: &Connection) -> Result<Vec<String>, StorageError> {
    Ok(owed_with_state(conn)?
        .into_iter()
        .map(|(doc_id, _)| doc_id)
        .collect())
}

/// The owed documents due this pass. One still waiting after a failure is
/// counted down one pass and left out.
pub fn due(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut due = Vec::new();
    for (doc_id, (failures, wait)) in owed_with_state(conn)? {
        if wait > 0 {
            write(conn, &doc_id, failures, wait - 1)?;
        } else {
            due.push(doc_id);
        }
    }
    Ok(due)
}

/// A debt's `(failures, passes to wait)`.
type Backoff = (u32, u32);

fn owed_with_state(conn: &Connection) -> Result<Vec<(String, Backoff)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT substr(key, ?1), value FROM meta
             WHERE substr(key, 1, ?2) = ?3 ORDER BY key",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![
                OWED_PREFIX.len() as i64 + 1,
                OWED_PREFIX.len() as i64,
                OWED_PREFIX
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut live = Vec::with_capacity(rows.len());
    for (doc_id, value) in rows {
        if is_deleted_document(conn, &doc_id)? {
            settle(conn, &doc_id)?;
        } else {
            live.push((doc_id, parse(&value)));
        }
    }
    Ok(live)
}

/// A `note` or `journal` row deleted here, or a bare tombstone (§5.12.1):
/// its body must not come back (§7.15).
pub(crate) fn is_deleted_document(conn: &Connection, doc_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM sync_items WHERE item_id = ?1 AND deleted_at IS NOT NULL
           AND item_type IN ('note', 'journal', ?2)",
        params![doc_id, BARE_TOMBSTONE_ITEM_TYPE],
        |_| Ok(()),
    )
    .optional()
    .map_err(failed)
    .map(|found| found.is_some())
}

/// Owes a body pull for every `note` and `journal` record of the page not
/// already owed one, in one transaction, and answers which ones it added.
pub(crate) fn owe_page(
    conn: &Connection,
    pending: &[Pending],
) -> Result<Vec<String>, StorageError> {
    let txn = conn.unchecked_transaction().map_err(failed)?;
    let mut added = Vec::new();
    for item in pending {
        let Pending::Record(record) = item else {
            continue;
        };
        if !DOCUMENT_TYPES.contains(&record.item_type.as_str()) || is_owed(&txn, &record.item_id)? {
            continue;
        }
        owe(&txn, &record.item_id)?;
        added.push(record.item_id.clone());
    }
    txn.commit().map_err(failed)?;
    Ok(added)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::store;

    #[test]
    fn a_debt_is_listed_until_it_is_settled() {
        let dir = temp_dir("body-debt");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            owe(conn, "note-b")?;
            owe(conn, "note-a")?;
            owe(conn, "note-a")?;
            assert_eq!(owed(conn)?, ["note-a", "note-b"]);
            assert!(is_owed(conn, "note-a")?);
            settle(conn, "note-a")?;
            assert!(!is_owed(conn, "note-a")?);
            assert_eq!(owed(conn)?, ["note-b"]);
            Ok(())
        })
        .expect("debts");
    }

    #[test]
    fn a_failing_document_waits_twice_as_many_passes_each_time_up_to_the_cap() {
        // #2297 review A-9/B-7: a document that stops every pass is not
        // pulled every pass.
        let dir = temp_dir("body-debt-backoff");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            owe(conn, "note-a")?;
            assert_eq!(due(conn)?, ["note-a"]);
            owe_after_failure(conn, "note-a")?;
            // One failure: wait one pass.
            assert!(due(conn)?.is_empty());
            assert_eq!(due(conn)?, ["note-a"]);
            owe_after_failure(conn, "note-a")?;
            // Two failures: wait two passes.
            assert!(due(conn)?.is_empty());
            assert!(due(conn)?.is_empty());
            assert_eq!(due(conn)?, ["note-a"]);
            for _ in 0..10 {
                owe_after_failure(conn, "note-a")?;
            }
            let waited = (0..=MAX_WAIT_PASSES)
                .take_while(|_| due(conn).map(|due| due.is_empty()).unwrap_or(false))
                .count();
            assert_eq!(waited as u32, MAX_WAIT_PASSES);
            // `owe` keeps the count; settling clears it.
            owe(conn, "note-a")?;
            settle(conn, "note-a")?;
            assert!(!is_owed(conn, "note-a")?);
            Ok(())
        })
        .expect("backoff");
    }

    #[test]
    fn a_tombstoned_document_is_settled_rather_than_listed() {
        // #2297 review A-2/B-2: a debt must never pull a deleted body back.
        let dir = temp_dir("body-debt-tombstone");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            owe(conn, "note-a")?;
            owe(conn, "note-b")?;
            store::mark_deleted(conn, "note", "note-a", 5, None, 5)?;
            assert_eq!(owed(conn)?, ["note-b"]);
            assert!(!is_owed(conn, "note-a")?);
            Ok(())
        })
        .expect("tombstoned debts");
    }
}
