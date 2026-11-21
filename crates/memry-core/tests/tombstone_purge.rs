//! §7.15's first two consequences, on the paths `tests/tombstone.rs` does not
//! reach: the untyped delete, the id collision the purge must survive, the
//! projection that chooses the bodies window, and the purge that cannot run.
//!
//! | Test                                          | Rule                        |
//! | --------------------------------------------- | --------------------------- |
//! | an untyped delete marks every type and purges | §5.12.1, §7.15              |
//! | a colliding id does not take the note's body  | §5.12.1, §7.15              |
//! | the deleted note leaves the bodies window     | §7.15, §A.2                 |
//! | a purge that cannot run takes the delete with it | §7.15                    |
//!
//! Real `rusqlite` on disk and the real `PullLoop`; the transport and the
//! record cipher are the two seams the core does not own. **Nothing here
//! reaches a network.**

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log;
use memry_core::crdt::{Document, DocumentRegistry};
use memry_core::domain::note_files::{self, NoteFileStat};
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope, SyncOperation};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox;
use memry_core::sync::pull::{PullError, PullLoop, PullReport, RecordCipher};
use serde_json::{Value as Json, json};
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOTE: &str = "abc123def456";
const DEVICE: &str = "device-core";
const DELETED_AT: i64 = 1_700_000_500_000;
const NOW: i64 = 1_700_000_000_000;

// ------------------------------------------------------------------ plumbing

fn scratch_db(label: &str) -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-tombstone-purge-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn storage_failure(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// §5.12, §13.7.2: a delete's body is never applied, so a cipher that opens
/// a delete to an empty payload and nothing else is enough to drive the whole
/// path — and turns a delete that *did* reach a parser into a failure rather
/// than a silent pass.
struct OpensDeletes;

impl RecordCipher for OpensDeletes {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        // §5.14: a delete opens before it applies; this one opens to the
        // empty payload a signed delete seals.
        if envelope.deleted_at.is_some() || envelope.operation == SyncOperation::Delete {
            return Ok(Vec::new());
        }
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// A signed item whose `deletedAt` is set: what the server answers with for a
/// deleted item of a known type (§5.12).
fn tombstone_item(item_type: &str) -> Json {
    json!({
        "id": NOTE,
        "type": item_type,
        "operation": "update",
        "clientUpdatedAt": DELETED_AT,
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-desktop",
        "deletedAt": DELETED_AT,
    })
}

/// One real pull page: a `/sync/changes` answer and the `/sync/pull` answer
/// that follows it.
async fn pull_one_page(
    db: &Db,
    changes: Json,
    items: Json,
    vault_root: Option<PathBuf>,
) -> Result<PullReport, PullError> {
    let transport = FakeTransport::new(vec![
        response(200, &changes.to_string()),
        response(200, &json!({ "items": items }).to_string()),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(OpensDeletes),
    )
    // A delete over unsent text keeps it as an inbox capture (#3029), which
    // is clocked under this device.
    .with_clock_device(DEVICE);
    match vault_root {
        Some(root) => pull.with_vault_root(root),
        None => pull,
    }
    .pull_page()
    .await
}

/// A typed delete for `item_type`, carried by a ref row plus its signed item.
async fn deliver_typed_delete(db: &Db, item_type: &str) -> Result<PullReport, PullError> {
    deliver_typed_delete_in(db, item_type, None).await
}

/// [`deliver_typed_delete`] to a loop that reads note files under `vault_root`.
async fn deliver_typed_delete_in(
    db: &Db,
    item_type: &str,
    vault_root: Option<PathBuf>,
) -> Result<PullReport, PullError> {
    pull_one_page(
        db,
        json!({
            "items": [{"id": NOTE, "type": item_type}],
            "deleted": [],
            "hasMore": false,
            "nextCursor": "77",
        }),
        json!([tombstone_item(item_type)]),
        vault_root,
    )
    .await
}

/// An id in `deleted` with **no ref row and no typed item**: nothing on the
/// wire says what type it is, and nothing signs it.
async fn deliver_bare_deleted_id(db: &Db) -> Result<PullReport, PullError> {
    pull_one_page(
        db,
        json!({
            "items": [],
            "deleted": [NOTE],
            "hasMore": false,
            "nextCursor": "77",
        }),
        json!([]),
        None,
    )
    .await
}

// ------------------------------------------------------------------ fixtures

fn registry() -> DocumentRegistry {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new(DEVICE, sink)
}

fn seed_note(db: &Db) {
    db.call_blocking(|conn| {
        notes::create(
            conn,
            &NewNote {
                id: NOTE,
                title: "Shared note",
                folder_path: None,
                content: "",
                tags: &["shared".to_owned()],
                properties: None,
                emoji: None,
            },
            DEVICE,
            NOW,
        )
        .map(|durable| durable.acknowledge())
    })
    .expect("create the note");
}

/// One body edit, committed the way FR-030 requires: the update row and its
/// outbox row in one transaction.
fn edit_the_body(db: &Db, document: &Document) {
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").expect("the body root");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new("still typing"));
        })
        .expect("write");
    let update = document.encode_state().expect("encode");
    let change = outbox::Change::crdt_update("note", NOTE, update.clone());
    db.call_blocking(move |conn| {
        outbox::commit(conn, &change, NOW, |tx| {
            update_log::append_local_update_in(tx, NOTE, &update, NOW).map_err(storage_failure)
        })
    })
    .expect("the body edit commits");
}

// --------------------------------------------------------------- observations

fn body_rows(db: &Db) -> usize {
    db.call_blocking(|conn| {
        update_log::load_plan(conn, NOTE)
            .map(|plan| plan.server_updates.len() + plan.local_updates.len())
            .map_err(storage_failure)
    })
    .expect("the plan")
}

fn record_deleted_at(db: &Db, item_type: &str) -> Option<i64> {
    db.call_blocking(|conn| Ok(sync_items::load(conn, item_type, NOTE)?.map(|row| row.deleted_at)))
        .expect("the row")
        .expect("a row for that type")
}

fn projected_deleted_at(db: &Db, table: &str, key: &str) -> Option<i64> {
    let sql = format!("SELECT deleted_at FROM {table} WHERE {key} = ?1");
    db.call_blocking(|conn| {
        conn.query_row(&sql, [NOTE], |row| row.get(0))
            .map_err(storage_failure)
    })
    .expect("the projection row")
}

// --------------------------------------------------------------------- tests

/// A bare id in `deleted` is unsigned, so it deletes nothing on any tier
/// (§5.12.1, #5340): not the note, not a row of another type under the same
/// id (§5.15's collision, a tag named like the note), and not the body log.
/// Electron only fetches such an id (`changes-page.ts:38`).
#[tokio::test]
async fn a_bare_deleted_id_deletes_no_row_and_keeps_the_body() {
    let db = scratch_db("untyped");
    seed_note(&db);
    let registry = registry();
    edit_the_body(&db, &registry.get_or_open(NOTE).expect("open"));
    db.call_blocking(|conn| {
        sync_items::upsert_metadata_only(conn, "tag_definition", NOTE, NOW, None)
    })
    .expect("the second row");

    assert_eq!(body_rows(&db), 1);
    let report = deliver_bare_deleted_id(&db).await.expect("the page");

    assert_eq!(report.deleted, 0);
    assert_eq!(record_deleted_at(&db, "note"), None, "the note's row");
    assert_eq!(record_deleted_at(&db, "tag_definition"), None);
    assert_eq!(projected_deleted_at(&db, "notes", "id"), None);
    assert_eq!(body_rows(&db), 1, "the body log stays");
    assert!(report.purged_documents.is_empty());
}

/// A **typed** delete for a type that is not a document leaves the document's
/// body alone, even when the two share an id.
///
/// Id shapes are not disjoint across types (§5.12.1): a tag is named by its
/// own text, so a tag may legally be called the twelve characters a note id is
/// made of. Purging on the id alone would delete a live note's body because a
/// tag of the same name was deleted — and §7.15 keeps the server rows, so this
/// device would simply stop asking for them. Unrecoverable, and silent.
#[tokio::test]
async fn a_delete_for_a_colliding_tag_name_leaves_the_notes_body_alone() {
    let db = scratch_db("collision");
    seed_note(&db);
    let registry = registry();
    edit_the_body(&db, &registry.get_or_open(NOTE).expect("open"));

    let report = deliver_typed_delete(&db, "tag_definition")
        .await
        .expect("the page");

    // The tag was never live here, so its delete counts as skipped (S17-5).
    assert_eq!((report.deleted, report.skipped), (0, 1));
    assert_eq!(
        record_deleted_at(&db, "tag_definition"),
        Some(DELETED_AT),
        "the tag is deleted"
    );
    assert_eq!(
        record_deleted_at(&db, "note"),
        None,
        "and the note of the same id is not"
    );
    assert_eq!(projected_deleted_at(&db, "notes", "id"), None);
    assert_eq!(body_rows(&db), 1, "§7.15 purges documents, not names");
    assert!(
        report.purged_documents.is_empty(),
        "nothing was purged, and nothing claimed to be"
    );
}

/// Appends a blob no build decodes to the note's body log (#5343).
fn break_the_log(db: &Db) {
    db.call_blocking(|conn| {
        update_log::append_server_update(conn, NOTE, 1, &[0xff; 4], 1).map_err(storage_failure)
    })
    .expect("bytes no build decodes");
}

/// The inbox captures' contents.
fn kept(db: &Db) -> Vec<String> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT content FROM inbox_items")
            .map_err(storage_failure)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(storage_failure)?;
        rows.collect::<Result<_, _>>().map_err(storage_failure)
    })
    .expect("the captures")
}

/// A signed delete over a body log with a blob that does not replay applies,
/// purges the log and never fails the page (#5343). The unsent text is kept
/// from the note's vault file, where Electron reads every body
/// (`apps/desktop/src/main/sync/keep-unseen-text.ts:46-52`,
/// `item-handlers/note-handler.ts:750-760`).
// The frontmatter split is desktop's (`markdown`), as are vault files.
#[cfg(feature = "markdown")]
#[tokio::test]
async fn a_delete_over_a_body_that_does_not_replay_keeps_the_vault_files_text() {
    let db = scratch_db("unreplayable");
    seed_note(&db);
    let registry = registry();
    edit_the_body(&db, &registry.get_or_open(NOTE).expect("open"));
    break_the_log(&db);
    let root = tempfile::tempdir().expect("the vault folder");
    std::fs::write(
        root.path().join("shared.md"),
        "---\nid: abc123def456\n---\nstill typing in the file\n",
    )
    .expect("the note's file");
    db.call_blocking(|conn| {
        note_files::upsert_stats(
            conn,
            &[NoteFileStat {
                note_id: NOTE.to_owned(),
                path: "shared.md".to_owned(),
                file_type: "markdown".to_owned(),
                mime_type: None,
                file_size: None,
                content_hash: None,
                file_hash: None,
                indexed_at: NOW,
            }],
        )
    })
    .expect("the note's file row");

    let report = deliver_typed_delete_in(&db, "note", Some(root.path().to_owned()))
        .await
        .expect("the page applies");

    assert_eq!((report.deleted, report.corrupt), (1, 0), "{report:?}");
    assert!(record_deleted_at(&db, "note").is_some());
    assert_eq!(body_rows(&db), 0, "the unreadable log is purged");
    assert_eq!(kept(&db), ["still typing in the file\n"]);
}

/// VERIFY-5338B's repro: with no vault file to read (a shell with no vault
/// files), the unsent text in the blobs that do replay is kept, and the bad
/// blob never fails the page.
#[tokio::test]
async fn a_delete_over_a_partly_unreadable_log_keeps_the_text_that_replays() {
    let db = scratch_db("partly-unreadable");
    seed_note(&db);
    let registry = registry();
    edit_the_body(&db, &registry.get_or_open(NOTE).expect("open"));
    break_the_log(&db);

    let report = deliver_typed_delete(&db, "note")
        .await
        .expect("the page applies");

    assert_eq!((report.deleted, report.corrupt), (1, 0), "{report:?}");
    assert_eq!(body_rows(&db), 0, "the log is purged");
    let kept = kept(&db);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(kept[0].contains("still typing"), "{kept:?}");
}

/// The projection delete is what takes a tombstoned document out of the first
/// sync's bodies window, and out of every projection-driven read with it.
///
/// `sync::first_sync_store::recent_document_ids` picks pass three's work list
/// with `WHERE deleted_at IS NULL` over `notes` and `journal_entries`, and
/// hands what it finds to `body_pull::pull_document`, whose contract says
/// callers must not pass a tombstoned id: the server still answers with the
/// surviving log and re-applying it resurrects body state. Nothing but this
/// wrote that column on the inbound delete path. The query is asserted rather
/// than called because it is `pub(super)`; it is the predicate, verbatim.
#[tokio::test]
async fn a_deleted_note_leaves_the_bodies_window_and_the_tag_rows_with_it() {
    let db = scratch_db("window");
    seed_note(&db);

    let live: Vec<String> = db
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT id FROM notes WHERE deleted_at IS NULL")
                .map_err(storage_failure)?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(storage_failure)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_failure)?;
            Ok(ids)
        })
        .expect("the window");
    assert_eq!(
        live,
        vec![NOTE.to_owned()],
        "inside the window to begin with"
    );

    deliver_typed_delete(&db, "note").await.expect("the page");

    assert_eq!(projected_deleted_at(&db, "notes", "id"), Some(DELETED_AT));
    assert_eq!(
        projected_deleted_at(&db, "note_tags", "note_id"),
        Some(DELETED_AT),
        "§A.4: a child row carries the same three columns as its parent, so a \
         deleted note is not still live in the tag views"
    );
    let still_live: i64 = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT count(*) FROM notes WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(storage_failure)
        })
        .expect("count");
    assert_eq!(still_live, 0, "and out of it afterwards");
}

/// A purge that cannot run takes the whole delete down with it, rather than
/// leaving a record row that says the body is gone when it is not.
///
/// The three statements are one transaction on purpose. Here the purge is made
/// to fail at the storage layer — the one way it can fail, since it decodes
/// nothing — and the requirement is that **nothing** is left behind: the record
/// row is not marked, the projection is not marked, the page aborts with the
/// cursor unmoved, and the delete arrives again on the next pass. The opposite
/// outcome is the dangerous one: a caller that believes the body is gone.
#[tokio::test]
async fn a_purge_that_cannot_run_rolls_the_whole_delete_back() {
    let db = scratch_db("purge-fails");
    seed_note(&db);
    let registry = registry();
    edit_the_body(&db, &registry.get_or_open(NOTE).expect("open"));

    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER refuse_the_purge BEFORE DELETE ON yjs_updates
             BEGIN SELECT RAISE(ABORT, 'the disk refused'); END;",
        )
        .map_err(storage_failure)
    })
    .expect("arm the fault");

    let failure = deliver_typed_delete(&db, "note")
        .await
        .expect_err("the page cannot succeed when the purge cannot run");
    assert!(
        failure.to_string().contains("the disk refused"),
        "the reason survives to the caller: {failure}"
    );

    assert_eq!(
        record_deleted_at(&db, "note"),
        None,
        "the record delete rolled back with the purge"
    );
    assert_eq!(projected_deleted_at(&db, "notes", "id"), None);
    assert_eq!(body_rows(&db), 1, "and the body is still there to purge");

    // With the fault cleared the same delete lands whole, which is what makes
    // the abort a retry rather than a wedge.
    db.call_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER refuse_the_purge")
            .map_err(storage_failure)
    })
    .expect("clear the fault");
    let report = deliver_typed_delete(&db, "note").await.expect("the page");
    assert_eq!(record_deleted_at(&db, "note"), Some(DELETED_AT));
    assert_eq!(projected_deleted_at(&db, "notes", "id"), Some(DELETED_AT));
    assert_eq!(body_rows(&db), 0);
    assert_eq!(report.purged_documents, vec![NOTE.to_owned()]);
}
