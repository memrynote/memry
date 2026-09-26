//! `coversThrough` on the snapshot push (chapter 07 §7.7, #2299).
//!
//! The pusher claims its record cursor only once the one-time legacy body
//! pull is `done`, and only for a document it owes nothing; a server that
//! refuses the claim (`CRDT_SNAPSHOT_NOT_COVERED`) leaves the document owed,
//! so the next push is refused locally rather than sent again.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, error_response, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::snapshots::{
    Refusal, SnapshotGate, SnapshotOutcome, SnapshotPusher, SnapshotSealer,
};
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{Document, DocumentRegistry};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use memry_core::sync::body_pull::crdt_cursor_scope;
use memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL;
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::json;
use yrs::{ReadTxn as _, StateVector, Transact as _, XmlFragment as _, XmlTextPrelim};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-covers-through-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// The envelope is chapter 04's concern and `crdt_snapshots.rs` tests it;
/// here only the request body matters.
struct PlainSealer;

impl SnapshotSealer for PlainSealer {
    fn seal_snapshot(&self, _doc_id: &str, state: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(state.to_vec())
    }
}

fn pusher(db: &Db, transport: Arc<FakeTransport>) -> SnapshotPusher {
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    SnapshotPusher::new(
        http,
        db.clone(),
        Arc::new(PlainSealer),
        Declaration::subscribed(),
    )
}

fn document() -> (DocumentRegistry, Arc<Document>) {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-a", sink);
    let document = registry.get_or_open(NOTE).expect("open");
    let author = yrs::Doc::with_client_id(99);
    let body = author.get_or_insert_xml_fragment("prosemirror");
    body.insert(&mut author.transact_mut(), 0, XmlTextPrelim::new("body"));
    let state = author
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    document.apply_durable_update(&state).expect("apply");
    (registry, document)
}

/// This device has read the note's server body: a `crdt:` cursor (#2299,
/// review A-6: only such a document claims).
fn hold(db: &Db) {
    db.call_blocking(|conn| store::write_cursor(conn, &crdt_cursor_scope(NOTE), Some("0"), 1))
        .expect("hold the body");
}

/// A device at record cursor `cursor`, with the legacy pull in `legacy`, that
/// has read the note's server body.
fn seed(db: &Db, cursor: Option<&str>, legacy: Option<&str>) {
    hold(db);
    let cursor = cursor.map(str::to_owned);
    let legacy = legacy.map(str::to_owned);
    db.call_blocking(move |conn| {
        if let Some(cursor) = cursor {
            store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some(&cursor), 1)?;
        }
        if let Some(legacy) = legacy {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [META_NOTE_BODY_LEGACY_PULL, legacy.as_str()],
            )
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?;
        }
        Ok(())
    })
    .expect("seed the device");
}

async fn sent_body(db: &Db) -> serde_json::Value {
    let (_registry, document) = document();
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"sequenceNum": 1, "revision": "rev-pushed"}).to_string(),
    )]);
    let outcome = pusher(db, transport.clone())
        .push(&document, SnapshotGate::clean(), 1)
        .await
        .expect("the push");
    assert!(
        matches!(outcome, SnapshotOutcome::Pushed { .. }),
        "{outcome:?}"
    );
    http_fakes::body_json(&transport.calls_to("/sync/crdt/snapshot")[0])
}

/// #2299: the record cursor is the claim once the legacy pull is `done`.
#[tokio::test]
async fn a_push_claims_the_record_cursor_once_the_legacy_pull_is_done() {
    let db = scratch_db("claims");
    seed(&db, Some("50"), Some("done"));

    assert_eq!(sent_body(&db).await["coversThrough"], json!(50));
}

/// #2299: rows below the cursor at first negotiation were never served as
/// bodies, so nothing is claimed until the legacy pull owed them all.
#[tokio::test]
async fn a_push_claims_nothing_before_the_legacy_pull_or_without_a_cursor() {
    let before = scratch_db("no-legacy");
    seed(&before, Some("50"), None);
    assert!(sent_body(&before).await.get("coversThrough").is_none());

    let fresh = scratch_db("no-cursor");
    seed(&fresh, None, Some("done"));
    assert!(sent_body(&fresh).await.get("coversThrough").is_none());
}

/// #2299: a peer snapshot above the claim is refused per note. The document
/// is owed a pull, so the retry is refused locally, never sent again, until a
/// pull settles the debt.
#[tokio::test]
async fn a_not_covered_refusal_owes_the_document_and_is_never_retried_hot() {
    let db = scratch_db("not-covered");
    seed(&db, Some("50"), Some("done"));
    let (_registry, document) = document();
    let transport = FakeTransport::new(vec![error_response(
        409,
        "CRDT_SNAPSHOT_NOT_COVERED",
        "above coversThrough",
    )]);
    let pusher = pusher(&db, transport.clone());

    let first = pusher
        .push(&document, SnapshotGate::clean(), 1)
        .await
        .expect("a refusal, not an error");
    let second = pusher
        .push(&document, SnapshotGate::clean(), 2)
        .await
        .expect("refused locally");

    assert_eq!(
        first,
        SnapshotOutcome::Refused(Refusal::UnmergedRemoteState)
    );
    assert_eq!(
        second,
        SnapshotOutcome::Refused(Refusal::UnmergedRemoteState)
    );
    assert_eq!(transport.call_count(), 1);
    assert!(
        db.call_blocking(|conn| body_debt::is_owed(conn, NOTE))
            .expect("read the debt")
    );
}

/// #2299 review A-6: the legacy pull owed only documents holding body state
/// then. A document this device never read from the server (only local rows)
/// claims nothing, so its push can never prune peer rows it never merged.
#[tokio::test]
async fn a_document_whose_server_body_was_never_read_claims_nothing() {
    let db = scratch_db("never-read");
    seed(&db, Some("50"), Some("done"));
    db.call_blocking(|conn| {
        conn.execute(
            "DELETE FROM sync_cursors WHERE scope = ?1",
            [crdt_cursor_scope(NOTE)],
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("forget the body cursor");

    assert!(sent_body(&db).await.get("coversThrough").is_none());
}

/// #2299 review A-9/B-4 and 07 §7.13.4: the revision the push answered is
/// recorded, and the next claimed push names it as its base, so consecutive
/// pushes of this device never meet a refusal on their own snapshot.
#[tokio::test]
async fn the_answered_revision_is_recorded_and_sent_as_the_next_base() {
    let db = scratch_db("base");
    seed(&db, Some("50"), Some("done"));

    let first = sent_body(&db).await;
    assert!(first.get("baseRevision").is_none());
    let stored = db
        .call_blocking(|conn| {
            update_log::snapshot(conn, Namespace::Server, NOTE).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("read")
        .expect("a stored snapshot");
    assert_eq!(stored.server_revision.as_deref(), Some("rev-pushed"));

    let second = sent_body(&db).await;
    assert_eq!(second["baseRevision"], json!("rev-pushed"));
}
