//! `notes edit <id> --append <text>`: the headless write G5 needs (T125).
//!
//! This exists for one reason: quickstart §G5 asks for a write a **real
//! desktop renders as a real block**, made by a client that is not the editor
//! bundle. It is not a markdown path, it is not reachable from the phone, and
//! it will never grow one — chapter 12 §12.1 puts both markdown directions
//! inside the editor bundle and §12.1.2 leaves a non-editor client with
//! `extract_text` and nothing else. What this file does instead is build one
//! schema-shaped node with the yrs API and hand it to the document.
//!
//! **The node** and the parent it goes into are [`node`]'s, which is also
//! where the sources for each part of the shape are written down.
//!
//! **What this file owns** is everything around it: which note, whether that
//! note may be written to at all, loading its body out of the update log, and
//! making the resulting update durable in the same transaction as its outbox
//! row (FR-030).
//!
//! **What it never does.** It never appends to a document it could not load.
//! An unreadable or unpulled body is an error, never an empty document that
//! then gets one paragraph written over the user's note.

use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::storage::Db;
use memry_core::sync::outbox;

use crate::session::{Cli, CliError};

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
    let (document, authored) = load_body(&db, note, &device_id)?;

    let before = extract_text(&document)?;
    let block_id = block_id();
    document.write(|txn| append_paragraph(txn, &block_id, text))??;
    let update = one_update(&authored)?;

    let seq = record(&db, &item_type, note, &update, now_ms())?;
    // Only now: the acknowledgement follows the commit, never precedes it
    // (data-model §C.4, FR-030).
    let after = extract_text(&document)?;

    println!(
        "appended {} bytes to {note} as block {block_id}, local update {seq}",
        update.len()
    );
    println!("lines {} -> {}", line_count(&before), line_count(&after));
    Ok(())
}

/// The one update the one write transaction produced.
///
/// The bytes come from the registry's own update sink, which is the only
/// place they exist. The alternative — encoding the document before and after
/// and diffing two copies — is exactly the "assemble a document" move chapter
/// 12 §12.5.1 forbids, and it would be a second Y.Doc for the same note.
fn one_update(authored: &Mutex<Vec<Vec<u8>>>) -> Result<Vec<u8>, CliError> {
    let mut updates = authored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match updates.len() {
        1 => Ok(updates.remove(0)),
        // Neither can happen with one write on one transaction. Saying so
        // beats recording bytes nobody can account for.
        0 => Err(CliError::Refused(
            "the append produced no Yjs update, so there is nothing to record".to_string(),
        )),
        many => Err(CliError::Refused(format!(
            "the append produced {many} Yjs updates where one transaction must produce one"
        ))),
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

/// The document, or an error — **never** a fresh empty one.
///
/// `notes text` may open a body with nothing in the log and print nothing;
/// this path may not. A document whose log is empty has not been pulled, and
/// appending to it would push one paragraph that a desktop merges into a note
/// this client never held.
type Authored = Arc<Mutex<Vec<Vec<u8>>>>;

fn load_body(db: &Db, note: &str, device_id: &str) -> Result<(Arc<Document>, Authored), CliError> {
    let doc_id = note.to_string();
    let plan = db.call_blocking(move |conn| {
        update_log::load_plan(conn, &doc_id).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })?;

    if plan.is_empty() {
        return Err(CliError::Refused(format!(
            "the body of `{note}` is not in this vault's update log: run `memry pull` first. \
             Appending to an unloaded document would replace a note that exists on the server \
             with one paragraph"
        )));
    }

    // One registry, one document, one sink — the registry's own local-update
    // path. Nothing applied here reaches the sink: `apply_durable_update`
    // stamps the durable origin precisely so a replay is not re-enqueued as
    // this device's edit, so the vector is still empty when the write runs.
    let authored: Authored = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(bytes.to_vec());
        })
    };
    let document = DocumentRegistry::new(device_id, sink).get_or_open(note)?;
    for blob in plan.blobs() {
        // An update that will not decode or will not apply ends the command.
        // Reading it as "nothing was there" is the one outcome that loses a
        // note.
        document.apply_durable_update(blob)?;
    }
    Ok((document, authored))
}

/// The update row and its outbox row, in **one** transaction (FR-030,
/// data-model §A.2).
///
/// `Change::CrdtUpdate` carries the bytes because there is no live row to
/// rebuild them from, and `outbox::enqueue` deliberately does not collapse
/// CRDT rows: a merged update cannot be re-sent individually, and collapsing
/// drops updates a peer has not seen.
fn record(
    db: &Db,
    item_type: &str,
    note: &str,
    update: &[u8],
    now_ms: i64,
) -> Result<i64, CliError> {
    let change = outbox::Change::crdt_update(item_type, note, update.to_vec());
    let doc_id = note.to_string();
    let update = update.to_vec();
    let durable = db.call_blocking(move |conn| {
        outbox::commit(conn, &change, now_ms, |tx| {
            update_log::append_local_update_in(tx, &doc_id, &update, now_ms).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
    })?;
    Ok(durable.acknowledge())
}

#[cfg(test)]
mod tests {
    use super::node::fixtures::*;
    use super::*;

    /// The whole write, end to end over a real database, minus the profile:
    /// load from the log, write through the registry, take the one update off
    /// the sink, and hand those bytes to a peer that holds only the original
    /// state. What the peer ends up with is what a desktop ends up with.
    #[test]
    fn the_loaded_document_authors_one_update_that_carries_the_paragraph() {
        let (dir, db) = scratch("end-to-end");
        let base = from_hex(PLAIN_PARAGRAPH_VECTOR);
        let seeded = base.clone();
        db.call_blocking(move |conn| {
            update_log::append_server_update(conn, "note-1", 1, &seeded, 1_700_000_000_000).map_err(
                |error| StorageError::Failed {
                    what: error.to_string(),
                },
            )
        })
        .expect("seed the server namespace");

        let (document, authored) = load_body(&db, "note-1", "device-a").expect("loads");
        assert_eq!(
            extract_text(&document).expect("extract"),
            "One plain paragraph."
        );
        // The replay reached the document without reaching the sink: a
        // replayed update re-enqueued as a local edit would re-push the whole
        // document on every launch.
        assert!(authored.lock().expect("lock").is_empty());

        document
            .write(|txn| append_paragraph(txn, "block-1", "from cli"))
            .expect("a transaction")
            .expect("appends");
        let update = one_update(&authored).expect("exactly one update");

        let peer = doc();
        apply(&peer, &base);
        apply(&peer, &update);
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
        let refused = load_body(&db, "alive", "device-a");
        assert!(
            matches!(&refused, Err(CliError::Refused(message)) if message.contains("update log")),
            "{:?}",
            refused.map(|_| "a document")
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
        let update = vec![1u8, 2, 3];
        let seq = record(&db, "note", "note-1", &update, 1_700_000_000_000).expect("records");
        assert_eq!(seq, 1, "the first local sequence");

        let rows: (String, Vec<u8>, String, String, Option<Vec<u8>>) = db
            .call_blocking(|conn| {
                conn.query_row(
                    "SELECT u.doc_id, u.update_blob, o.item_type, o.op, o.payload
                       FROM yjs_updates u JOIN outbox o ON o.item_id = 'note-1'",
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
        assert_eq!(rows.1, update);
        assert_eq!(rows.2, "note");
        assert_eq!(rows.3, outbox::OP_CRDT_UPDATE);
        assert_eq!(rows.4, Some(update));

        // A second append takes the next sequence rather than colliding, and
        // does not collapse the first: collapsing CRDT rows drops updates a
        // peer has not seen.
        assert_eq!(
            record(&db, "note", "note-1", &[4u8], 1_700_000_000_001).expect("records again"),
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
