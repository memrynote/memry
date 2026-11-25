//! `notes edit <id> --append <text>`: the headless write G5 needs (T125).
//!
//! This exists for one reason: quickstart §G5 asks for a write a **real
//! desktop renders as a real block**, made by a client that is not desktop.
//! It is not a markdown path, it is not reachable from the phone, and it will
//! never grow one: chapter 12 §12.1 gives desktop both markdown directions,
//! and §12.1.2 lets a non-desktop client parse markdown only through
//! `markdown_seed`, for two writes this is not. So this file builds one
//! schema-shaped node with the yrs API and hands it to the document.
//!
//! **The node** and the parent it goes into are [`node`]'s, which is also
//! where the sources for each part of the shape are written down.
//!
//! **What this file owns** is everything around it: which note, and whether
//! that note may be written to at all. Loading the body, authoring and storing
//! the update with its outbox row (FR-030) is the core's
//! [`body_write::write_body`], inside one write-locked transaction (#5734), so
//! a core write in another process can never land between the load and the
//! append.
//!
//! **What it never does.** It never appends to a document it could not load.
//! An unreadable or unpulled body is an error, never an empty document that
//! then gets one paragraph written over the user's note.

use memry_core::api::errors::StorageError;
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::domain::body_write;
use memry_core::storage::{Db, nested_tx};
use rusqlite::Connection;

use crate::session::{Cli, CliError};

#[cfg(test)]
mod lock_tests;
mod node;

use node::{append_paragraph, block_id};

/// A BlockNote block id, as `notes edit` mints one (for `journal append`).
pub(crate) fn new_block_id() -> String {
    block_id()
}

/// `notes edit <id> --append <text>`.
pub fn notes_append(
    cli: &Cli,
    note: &str,
    text: &str,
    vault: Option<&str>,
) -> Result<(), CliError> {
    if text.is_empty() {
        return Err(CliError::Refused(
            "--append needs text: an empty paragraph is dropped by extract_text and renders as \
             nothing"
                .to_string(),
        ));
    }

    let vault = crate::commands::resolve_vault(cli, vault)?;
    let db = cli.open_vault(&vault)?;
    // The Yjs client id is derived from this device's id, so a second run of
    // this command is the same Yjs client rather than a new one on every
    // launch (chapter 07, registry R2).
    let device_id = cli.device_id()?;

    let item_type = live_item_type(&db, note)?;
    let block_id = block_id();
    let appended = append_locked(&db, &item_type, note, text, &block_id, &device_id, now_ms())?;

    // Only now: the acknowledgement follows the commit, never precedes it
    // (data-model §C.4, FR-030).
    println!(
        "appended {} bytes to {note} as block {block_id}, local update {}",
        appended.bytes, appended.seq
    );
    println!(
        "lines {} -> {}",
        appended.lines_before, appended.lines_after
    );
    Ok(())
}

/// What one append stored.
#[derive(Debug)]
struct Appended {
    seq: i64,
    bytes: usize,
    lines_before: usize,
    lines_after: usize,
}

fn append_locked(
    db: &Db,
    item_type: &str,
    note: &str,
    text: &str,
    block_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Appended, CliError> {
    db.call_blocking(|conn| {
        Ok(append_in_tx(
            conn, item_type, note, text, block_id, device_id, now_ms,
        ))
    })?
}

/// The load, the write and the record, under one `BEGIN IMMEDIATE`: the
/// write lock is taken before the log is read and held to the commit.
fn append_in_tx(
    conn: &Connection,
    item_type: &str,
    note: &str,
    text: &str,
    block_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Appended, CliError> {
    let tx = nested_tx::begin(conn).map_err(storage_failed)?;

    // The document, or an error — **never** a fresh empty one. `notes text`
    // may open a body with nothing in the log and print nothing; this path
    // may not. A document whose log is empty has not been pulled, and
    // appending to it would push one paragraph that a desktop merges into a
    // note this client never held.
    if update_log::load_plan(&tx, note)?.is_empty() {
        return Err(CliError::Refused(format!(
            "the body of `{note}` is not in this vault's update log: run `memry pull` first. \
             Appending to an unloaded document would replace a note that exists on the server \
             with one paragraph"
        )));
    }

    let mut refused = None;
    let mut lines = (0, 0);
    let stored = body_write::write_body(&tx, item_type, note, device_id, now_ms, |document| {
        lines.0 = line_count(&extract_text(document)?);
        if let Err(error) = document.write(|txn| append_paragraph(txn, block_id, text))? {
            refused = Some(error);
            return Err(StorageError::Failed {
                what: "the append was refused".to_string(),
            }
            .into());
        }
        lines.1 = line_count(&extract_text(document)?);
        Ok(())
    });
    if let Some(error) = refused {
        return Err(error);
    }
    let Some((seq, bytes)) = stored? else {
        return Err(CliError::Refused(
            "the append produced no Yjs update, so there is nothing to record".to_string(),
        ));
    };
    tx.commit().map_err(storage_failed)?;
    Ok(Appended {
        seq,
        bytes,
        lines_before: lines.0,
        lines_after: lines.1,
    })
}

fn storage_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().count()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// The item type of a note or journal that still exists, or a refusal.
///
/// Three different "no" answers, kept apart on purpose: a document this vault
/// has never seen, one the feed says is deleted (§7.15), and one the pull
/// marked corrupt. Appending to any of them writes an edit nobody can ever
/// merge, and a fourth silent answer — treating the row as absent — is the
/// failure mode the read path already paid for once.
fn live_item_type(db: &Db, note: &str) -> Result<String, CliError> {
    let id = note.to_string();
    let row: Option<(String, Option<i64>, Option<String>)> = db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT item_type, deleted_at, corrupt_reason FROM sync_items \
             WHERE item_id = ?1 AND item_type IN ('note', 'journal')",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(StorageError::Failed {
                what: other.to_string(),
            }),
        })
    })?;

    match row {
        None => Err(CliError::Refused(format!(
            "no note or journal `{note}` in this vault: pull it first, and never append to a \
             document this client has not seen"
        ))),
        Some((_, Some(_), _)) => Err(CliError::Refused(format!(
            "note `{note}` is deleted: appending to a tombstoned document resurrects body state \
             the feed has already dropped (chapter 07 §7.15)"
        ))),
        Some((_, _, Some(reason))) => Err(CliError::Refused(format!(
            "note `{note}` is corrupt ({reason}): a body this client could not open is not a body \
             it may write to"
        ))),
        Some((item_type, None, None)) => Ok(item_type),
    }
}

#[cfg(test)]
mod tests {
    use super::node::fixtures::*;
    use super::*;
    use memry_core::crdt::epoch::HeldBody;
    use memry_core::sync::outbox;

    fn seed_server_body(db: &Db, base: Vec<u8>) {
        db.call_blocking(move |conn| {
            HeldBody::never_purged(conn, "note-1")
                .and_then(|held| held.append_server_update(1, &base, 1_700_000_000_000))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("seed the server namespace");
    }

    /// The whole write, end to end over a real database, minus the profile:
    /// load from the log, write through the core, and hand what the log then
    /// holds to a peer. What the peer ends up with is what a desktop ends up
    /// with.
    #[test]
    fn the_loaded_document_authors_one_update_that_carries_the_paragraph() {
        let (dir, db) = scratch("end-to-end");
        let base = from_hex(PLAIN_PARAGRAPH_VECTOR);
        seed_server_body(&db, base);

        let appended = append_locked(&db, "note", "note-1", "from cli", "block-1", "device-a", 1)
            .expect("appends");
        // The replay was not re-recorded as this device's edit: the append is
        // the first local update, and a replay re-enqueued would re-push the
        // whole document on every launch.
        assert_eq!(appended.seq, 1);
        assert_eq!((appended.lines_before, appended.lines_after), (1, 2));

        let plan = db
            .call_blocking(|conn| {
                update_log::load_plan(conn, "note-1").map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .expect("the log");
        assert_eq!(plan.local_updates.len(), 1, "one local update");
        let peer = doc();
        for blob in plan.blobs() {
            apply(&peer, blob);
        }
        assert_eq!(text_of(&peer), "One plain paragraph.\nfrom cli");
        assert!(
            shape(&peer).contains(
                "<blockContainer id=\"block-1\"><paragraph>from cli</paragraph></blockContainer>"
            ),
            "{}",
            shape(&peer)
        );

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------------------
    // The durable half: the refusals, and the one transaction.
    // ---------------------------------------------------------------------

    fn scratch(label: &str) -> (std::path::PathBuf, Db) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "memry-cli-edit-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let db = memry_core::storage::open_data(&dir.join("data.db")).expect("open data.db");
        (dir, db)
    }

    fn seed_item(db: &Db, sql: &str) {
        let sql = sql.to_string();
        db.call_blocking(move |conn| {
            conn.execute_batch(&sql)
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("seed sync_items");
    }

    /// Four different answers, and none of them is "an empty document".
    #[test]
    fn a_missing_deleted_or_corrupt_document_is_refused() {
        let (dir, db) = scratch("refusals");
        seed_item(
            &db,
            "INSERT INTO sync_items (item_type, item_id, payload_state, updated_at, deleted_at)
               VALUES ('note', 'gone', 'full', 10, 11);
             INSERT INTO sync_items (item_type, item_id, payload_state, updated_at, corrupt_reason)
               VALUES ('note', 'broken', 'full', 10, 'undecryptable');
             INSERT INTO sync_items (item_type, item_id, payload_state, updated_at)
               VALUES ('note', 'alive', 'full', 10);",
        );

        for (id, needle) in [
            ("never-seen", "pull it first"),
            ("gone", "is deleted"),
            ("broken", "is corrupt"),
        ] {
            let refused = live_item_type(&db, id);
            assert!(
                matches!(&refused, Err(CliError::Refused(message)) if message.contains(needle)),
                "{id}: {refused:?}"
            );
        }
        assert_eq!(live_item_type(&db, "alive").expect("a live note"), "note");

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The read path's lesson, made a test: a body that is not in the log is
    /// an error, never an empty document one paragraph is then written over.
    #[test]
    fn a_body_that_is_not_in_the_log_is_never_appended_to() {
        let (dir, db) = scratch("unpulled");
        let refused = append_locked(&db, "note", "alive", "text", "block-1", "device-a", 1);
        assert!(
            matches!(&refused, Err(CliError::Refused(message)) if message.contains("update log")),
            "{refused:?}"
        );

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-030: the update row and the outbox row are one transaction, and the
    /// outbox row carries the bytes because there is no live row to rebuild
    /// them from.
    #[test]
    fn the_update_row_and_its_outbox_row_commit_together() {
        let (dir, db) = scratch("record");
        seed_server_body(&db, from_hex(PLAIN_PARAGRAPH_VECTOR));
        let appended = append_locked(&db, "note", "note-1", "first", "block-1", "device-a", 1)
            .expect("records");
        assert_eq!(appended.seq, 1, "the first local sequence");

        let rows: (String, Vec<u8>, String, String, Option<Vec<u8>>) = db
            .call_blocking(|conn| {
                conn.query_row(
                    "SELECT u.doc_id, u.update_blob, o.item_type, o.op, o.payload
                       FROM yjs_updates u JOIN outbox o ON o.item_id = 'note-1'
                      WHERE u.created_at = 1",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .expect("both rows");

        // The local namespace, never the server's: a local append that took a
        // server sequence would silently drop one of the two.
        assert_eq!(rows.0, "local.note-1");
        assert_eq!(rows.1.len(), appended.bytes);
        assert_eq!(rows.2, "note");
        assert_eq!(rows.3, outbox::OP_CRDT_UPDATE);
        assert_eq!(rows.4, Some(rows.1.clone()));

        // A second append takes the next sequence rather than colliding, and
        // does not collapse the first: collapsing CRDT rows drops updates a
        // peer has not seen.
        assert_eq!(
            append_locked(&db, "note", "note-1", "second", "block-2", "device-a", 2)
                .expect("records again")
                .seq,
            2
        );
        let queued: i64 = db
            .call_blocking(|conn| {
                conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
            })
            .expect("count");
        assert_eq!(queued, 2);

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
