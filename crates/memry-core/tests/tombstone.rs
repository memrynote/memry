//! T134 — a note deleted on one device while edited on the other, against
//! real adapters.
//!
//! Real `rusqlite` on disk, real `yrs`, the real two-namespace update log, the
//! real `PullLoop` and `HttpClient`. The only fakes are the two seams the core
//! deliberately does not own: the `Transport` and the record cipher. **Nothing
//! here reaches a network.**
//!
//! | Test                                            | Rule                         |
//! | ----------------------------------------------- | ---------------------------- |
//! | either order reaches the identical state        | §5.12, §6.9.2, §7.15         |
//! | the body edit is orphaned, not a resurrection   | §7.15, §13.7.2               |
//! | the purge empties both namespaces               | chapter 07 §7.15             |
//! | a delete for a body-only document is recorded   | chapter 05 §5.12             |
//! | **a tripwire over the unimplemented half**      | §7.15, consequences 1 and 2  |
//!
//! ## The two tiers, and why the answer is deterministic at all
//!
//! Existence is a **record-tier** fact and a body is a **CRDT-tier** fact, and
//! the two never arbitrate. A tombstone bypasses the field merge and the
//! document gate entirely (§6.9.2, §13.7.2): a delete carries no clock, so
//! there is nothing for a concurrent body edit to lose to or win against. That
//! is what makes "delete versus edit" have one answer rather than a race — the
//! delete is recorded, and the body update becomes an **orphan**: bytes under a
//! document id that no live record names.
//!
//! §7.15 is the rest of it. Deleting a note removes **no** `crdt_updates` row
//! on the server, so the orphan survives there indefinitely, and a client that
//! pulled bodies for a tombstoned id would apply that log straight back into a
//! document the record feed says is gone. The three obligations are: purge the
//! local Y.Doc and the local update log, never pull bodies for a tombstoned
//! id, and never read the surviving server rows as evidence the delete failed.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{Document, DocumentRegistry, extract_text};
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";
const DEVICE: &str = "device-core";
/// The instant the *other* device recorded the delete at. Fixed, so the two
/// orderings below can be compared for equality rather than for shape.
const DELETED_AT: i64 = 1_700_000_500_000;
const NOW: i64 = 1_700_000_000_000;

// ------------------------------------------------------------------ plumbing

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-tombstone-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn storage_failure(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A cipher that refuses everything.
///
/// §5.12 and §13.7.2: a tombstone's body is **never decoded**, so a cipher
/// that cannot open anything is enough to drive the whole delete path. If the
/// delete ever reaches a parser this test stops compiling its way around the
/// problem and fails outright.
struct NeverOpens;

impl RecordCipher for NeverOpens {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// The envelope the server answers `/sync/pull` with for a deleted item: a
/// full signed item whose `deletedAt` is set (§5.12).
fn tombstone_item() -> Json {
    json!({
        "id": NOTE,
        "type": "note",
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

/// Runs one real pull page carrying the other device's delete.
async fn deliver_the_delete(db: &Db) {
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({
                "items": [{"id": NOTE, "type": "note"}],
                "deleted": [],
                "hasMore": false,
                "nextCursor": "77",
            })
            .to_string(),
        ),
        response(200, &json!({ "items": [tombstone_item()] }).to_string()),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let report = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NeverOpens),
    )
    .pull_page()
    .await
    .expect("the page");

    assert_eq!(report.deleted, 1, "the delete was recorded");
    assert_eq!(
        report.corrupt, 0,
        "§6.9.2: a tombstone bypasses the merge, so it can never be recorded \
         corrupt for lacking a clock"
    );
    assert!(!report.refused);
}

// ------------------------------------------------------------------ fixtures

fn registry() -> DocumentRegistry {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new(DEVICE, sink)
}

/// A note that exists on this device with a body, exactly as a create plus a
/// first edit leaves it.
fn seed_note(db: &Db) {
    db.call_blocking(|conn| {
        notes::create(
            conn,
            &NewNote {
                id: NOTE,
                title: "Shared note",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
            },
            DEVICE,
            NOW,
        )
        .map(|durable| durable.acknowledge())
    })
    .expect("create the note");
}

/// One body edit, through the door FR-030 requires: the update row and its
/// outbox row in the same transaction.
///
/// §12.5.0's layout, located rather than assumed — the `blockGroup` is created
/// here because the document is empty, and every later block would go inside
/// it.
fn edit_the_body(db: &Db, document: &Document, text: &str) -> Vec<u8> {
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").expect("the body root");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            container.insert_attribute(
                txn,
                "id",
                "44444444-4444-4444-8444-444444444444".to_owned(),
            );
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new(text));
        })
        .expect("write");
    // The whole state, which is what an edit to a document with no history
    // pushes anyway, and a full-state encode rather than a walk of named roots
    // (§12.5.1).
    let update = document.encode_state().expect("encode");

    let change = outbox::Change::crdt_update("note", NOTE, update.clone());
    let blob = update.clone();
    db.call_blocking(move |conn| {
        outbox::commit(conn, &change, NOW, |tx| {
            update_log::append_local_update_in(tx, NOTE, &blob, NOW).map_err(storage_failure)
        })
    })
    .expect("the body edit commits");
    update
}

// ------------------------------------------------------------- observations

/// Everything about this device that a later pass can see, as one value, so
/// two orderings are compared for **equality** rather than by re-asserting the
/// same six facts twice.
#[derive(Debug, PartialEq, Eq)]
struct Resolution {
    /// The record tier's verdict.
    record_deleted_at: Option<i64>,
    /// Whether the delete left the stored payload alone (§5.12: never decoded).
    record_has_payload: bool,
    /// The projection the body-pull window is chosen from.
    projected_deleted_at: Option<i64>,
    /// Rows left in the `<id>` and `local.<id>` namespaces.
    server_updates: usize,
    local_updates: usize,
    /// What is still queued to push, as `(op, item_id)`.
    outbox: Vec<(String, String)>,
}

fn observe(db: &Db) -> Resolution {
    db.call_blocking(|conn| {
        let row = sync_items::load(conn, "note", NOTE)?.expect("the note's row");
        let projected_deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM notes WHERE id = ?1", [NOTE], |r| {
                r.get(0)
            })
            .map_err(storage_failure)?;
        let plan = update_log::load_plan(conn, NOTE).map_err(storage_failure)?;
        let mut statement = conn
            .prepare("SELECT op, item_id FROM outbox ORDER BY id")
            .map_err(storage_failure)?;
        let outbox: Vec<(String, String)> = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(storage_failure)?
            .collect::<Result<_, _>>()
            .map_err(storage_failure)?;
        Ok(Resolution {
            record_deleted_at: row.deleted_at,
            record_has_payload: row.payload.is_some(),
            projected_deleted_at,
            server_updates: plan.server_updates.len(),
            local_updates: plan.local_updates.len(),
            outbox,
        })
    })
    .expect("observe")
}

// --------------------------------------------------------------------- tests

/// The one T134 exists for: the two orderings of the same race land on the
/// identical state.
///
/// Device A edits the body and *then* learns of the delete; device B learns of
/// the delete and *then* the editor it still had open writes. Both are real —
/// the record feed and the body feed are separate streams with no shared
/// ordering — and a client whose answer depended on which arrived first would
/// leave two devices permanently disagreeing about whether the note exists.
#[tokio::test]
async fn a_delete_and_a_concurrent_body_edit_resolve_identically_in_either_order() {
    // --- device A: edit, then delete ---
    let a = scratch_db("edit-then-delete");
    seed_note(&a);
    let a_registry = registry();
    let a_doc = a_registry.get_or_open(NOTE).expect("open");
    let a_update = edit_the_body(&a, &a_doc, "typed before the delete arrived");
    deliver_the_delete(&a).await;

    // --- device B: delete, then edit ---
    let b = scratch_db("delete-then-edit");
    seed_note(&b);
    let b_registry = registry();
    let b_doc = b_registry.get_or_open(NOTE).expect("open");
    deliver_the_delete(&b).await;
    let b_update = edit_the_body(&b, &b_doc, "typed before the delete arrived");

    // The two devices authored the same edit under the same Yjs client id
    // (§7.16: derived from the device id), so the *bytes* are identical too —
    // which is what makes the comparison below about the resolution rather
    // than about incidental differences.
    assert_eq!(a_update, b_update);

    let a_state = observe(&a);
    let b_state = observe(&b);
    assert_eq!(
        a_state, b_state,
        "delete-versus-edit has one answer: the arrival order of the record \
         feed and the body feed must not change the result"
    );

    // And the answer is the delete, not the edit. §6.9.2: a tombstone bypasses
    // the merge entirely, so the concurrent edit never gets a vote.
    assert_eq!(a_state.record_deleted_at, Some(DELETED_AT));
    assert!(
        a_state.record_has_payload,
        "§5.12: the delete never decoded the body, so the stored payload is \
         exactly the bytes that were already there"
    );
}

/// The body edit is **orphaned**, not a resurrection.
///
/// The edit is real, durable, and still queued to push — §7.15 does not throw
/// it away, and the server will keep it forever. What it must not do is put
/// the note back: existence is a record-tier fact, and nothing on the CRDT
/// tier writes a record row.
#[tokio::test]
async fn the_concurrent_body_edit_is_orphaned_and_never_resurrects_the_note() {
    let db = scratch_db("orphan");
    seed_note(&db);
    let registry = registry();
    let document = registry.get_or_open(NOTE).expect("open");
    edit_the_body(&db, &document, "still typing");

    deliver_the_delete(&db).await;

    let after = observe(&db);
    assert_eq!(after.record_deleted_at, Some(DELETED_AT));

    // The orphan: a local update row and a queued push under a document id no
    // live record names.
    assert_eq!(after.local_updates, 1, "the edit survived the delete");
    assert!(
        after
            .outbox
            .iter()
            .any(|(op, id)| op == outbox::OP_CRDT_UPDATE && id == NOTE),
        "the body edit is still queued: {:?}",
        after.outbox
    );

    // Applying that orphan again — which is exactly what pulling bodies for a
    // tombstoned id would do — reconstructs body state and creates **no**
    // record row. Body bytes are not evidence of existence (§7.15, third
    // consequence).
    let reopened = DocumentRegistry::new("device-reader", Arc::new(|_, _| {}))
        .get_or_open(NOTE)
        .expect("open");
    for blob in db
        .call_blocking(|conn| update_log::load_plan(conn, NOTE).map_err(storage_failure))
        .expect("plan")
        .blobs()
    {
        reopened.apply_durable_update(blob).expect("replay");
    }
    assert_eq!(extract_text(&reopened).expect("extract"), "still typing");
    assert_eq!(
        observe(&db).record_deleted_at,
        Some(DELETED_AT),
        "replaying the orphaned body did not bring the note back"
    );
}

/// §7.15's first consequence: on applying a tombstone, the local Y.Doc and the
/// local update log go.
///
/// The purge is what makes the orphan stop being reachable on this device. It
/// must take **both** namespaces — the server rows the pull left behind and
/// the local rows the concurrent edit wrote — because either half alone
/// re-materialises a body for a note the record feed says is gone.
#[tokio::test]
async fn the_tombstone_purge_empties_both_namespaces_and_the_document() {
    let db = scratch_db("purge");
    seed_note(&db);
    let registry = registry();
    let document = registry.get_or_open(NOTE).expect("open");
    let update = edit_the_body(&db, &document, "still typing");
    // A server update too, so the purge has something in each namespace.
    db.call_blocking(|conn| {
        update_log::append_server_update(conn, NOTE, 1, &update, NOW).map_err(storage_failure)
    })
    .expect("a server row");

    deliver_the_delete(&db).await;

    let before = observe(&db);
    assert_eq!((before.server_updates, before.local_updates), (1, 1));

    // The obligation, performed as a tombstone handler must: purge the log,
    // then drop the in-memory document.
    db.call_blocking(|conn| update_log::purge(conn, NOTE).map_err(storage_failure))
        .expect("purge");
    assert!(registry.release(NOTE), "the Y.Doc is dropped too");

    let after = observe(&db);
    assert_eq!((after.server_updates, after.local_updates), (0, 0));
    assert!(registry.peek(NOTE).is_none());
    db.call_blocking(|conn| {
        let plan = update_log::load_plan(conn, NOTE).map_err(storage_failure)?;
        assert!(plan.is_empty(), "neither a snapshot nor an update survives");
        // Both snapshot rows too: a fold point left behind would hand the next
        // local append a sequence that is already used.
        for namespace in [Namespace::Server, Namespace::Local] {
            assert!(
                update_log::snapshot(conn, namespace, NOTE)
                    .map_err(storage_failure)?
                    .is_none()
            );
        }
        Ok(())
    })
    .expect("read back");

    // A document re-opened after the purge is empty: the body is gone from
    // this device even though the server still holds every byte of it.
    let reopened = registry.get_or_open(NOTE).expect("reopen");
    assert_eq!(extract_text(&reopened).expect("extract"), "");
}

/// The tombstone is still the answer when the *only* thing this device ever
/// had for the note was a body.
///
/// §5.12: a delete for an item this device never pulled is still recorded, or
/// the next pull of that id resurrects it. The body feed carries no item type
/// and no existence claim, so a device holding `yjs_updates` rows and no record
/// row must end up deleted rather than half-alive.
#[tokio::test]
async fn a_delete_for_a_note_this_device_only_ever_had_a_body_for_is_still_recorded() {
    let db = scratch_db("body-only");
    let registry = registry();
    let document = registry.get_or_open(NOTE).expect("open");
    // No `seed_note`: no record row at all, only body bytes.
    edit_the_body(&db, &document, "a body with no record");

    deliver_the_delete(&db).await;

    db.call_blocking(|conn| {
        let row = sync_items::load(conn, "note", NOTE)?.expect("the delete minted the row");
        assert_eq!(row.deleted_at, Some(DELETED_AT));
        assert!(
            row.payload.is_none(),
            "a delete for an unseen item records the tombstone and nothing else"
        );
        Ok(())
    })
    .expect("read back");
}

/// **A tripwire over today's gap, not an endorsement of it.** When this test
/// fails, the gap has been closed — delete it and fold the two facts into the
/// tests above.
///
/// §7.15 gives a client applying a tombstone three obligations. The core meets
/// one of them today. `sync::apply::apply_page`'s tombstone arm calls
/// `sync::store::mark_deleted` and stops, so:
///
/// 1. **The local update log is not purged.** `crdt::update_log::purge` exists
///    and has **no production call site** anywhere in the crate;
///    [`the_tombstone_purge_empties_both_namespaces_and_the_document`] drives
///    it by hand because nothing else does.
/// 2. **The projection row is not marked deleted.** `mark_deleted` writes
///    `sync_items.deleted_at` and never reaches `projectors::project`, so the
///    `notes` row keeps `deleted_at IS NULL`. That column is what
///    `sync::first_sync_store::recent_document_ids` filters the bodies pass on
///    (`WHERE deleted_at IS NULL`), so a tombstoned note is still handed to
///    `body_pull::pull_document` — whose own contract says **callers must not
///    pass a tombstoned id**, because the server still answers with the
///    surviving log and applying it resurrects the body.
///
/// Together those are §7.15's first two consequences, unimplemented. The
/// record tier is correct and the body tier is not yet wired to it.
#[tokio::test]
async fn todays_gap_a_remote_tombstone_neither_purges_the_body_nor_marks_the_projection() {
    let db = scratch_db("gap");
    seed_note(&db);
    let registry = registry();
    let document = registry.get_or_open(NOTE).expect("open");
    edit_the_body(&db, &document, "still typing");

    deliver_the_delete(&db).await;

    let after = observe(&db);
    assert_eq!(
        after.record_deleted_at,
        Some(DELETED_AT),
        "the record tier is correct"
    );
    assert_eq!(
        after.local_updates, 1,
        "GAP 1 (§7.15): applying the tombstone left the local update log in          place. When the purge is wired in, this becomes 0 — delete this test."
    );
    assert_eq!(
        after.projected_deleted_at, None,
        "GAP 2 (§7.15): the `notes` projection is still live, so          `recent_document_ids` will hand this id to the bodies pass and the          surviving server log will be applied straight back. When the delete          reaches the projector, this becomes Some(DELETED_AT) — delete this          test."
    );
}
