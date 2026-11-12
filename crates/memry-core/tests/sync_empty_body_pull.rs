//! A document whose record arrived before its body (#4315).
//!
//! Desktop pushes a new journal day's record first and the text typed into it
//! later, as CRDT updates with no record. A phone that pulls in between
//! receives the record, owes the body, and the per-note pull reaches the
//! server's head with nothing to store. The later updates reach the phone only
//! through the change feed's `noteBodies`, which lands bodies only for
//! documents this device already knows. Search then never sees the text.
//!
//! Real `HttpClient`, SQLite, update log, FTS5 index and `yrs`; the transport
//! and the two ciphers are fakes. The body cipher hands the packed bytes back
//! as the plaintext.

mod http_fakes;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::domain::search;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::migrations::{self, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::body_step;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use rusqlite::Connection;
use serde_json::{Value as Json, json};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const JOURNAL: &str = "j2026-11-10";
const NOTE: &str = "laternote123";
const WORD: &str = "zephyrjournal";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> (PathBuf, Db) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-empty-body-pull-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    (dir, db)
}

struct ScriptedRecords(Mutex<Vec<(String, String)>>);

impl RecordCipher for ScriptedRecords {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.packed.to_vec())
    }
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

fn envelope(id: &str, item_type: &str) -> Json {
    json!({
        "id": id,
        "type": item_type,
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
    })
}

fn payload(item_type: &str) -> String {
    match item_type {
        "journal" => json!({"date": "2026-11-10", "content": "", "clock": {"device-b": 1}}),
        _ => json!({"title": "Typed later", "clock": {"device-b": 1}}),
    }
    .to_string()
}

/// A `blockContainer > paragraph > text` body, what desktop's editor writes.
fn body_update(text: &str) -> Vec<u8> {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn feed(
    db: &Db,
    script: Vec<Result<HttpResponse, memry_core::api::errors::TransportError>>,
    id: &str,
    item_type: &str,
) -> PullLoop {
    let records = Arc::new(ScriptedRecords(Mutex::new(vec![(
        id.to_owned(),
        payload(item_type),
    )])));
    PullLoop::new(
        http(FakeTransport::new(script)),
        db.clone(),
        Declaration::subscribed(),
        records,
    )
    .with_note_bodies(Arc::new(PassThrough))
}

fn body_pull(db: &Db, transport: Arc<FakeTransport>) -> BodyPull {
    BodyPull::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    )
}

fn empty_log() -> Vec<Result<HttpResponse, memry_core::api::errors::TransportError>> {
    vec![
        response(200, &json!({"snapshot": null}).to_string()),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]
}

/// Reindexes `dir`'s `index.db`, kept between calls as the phone keeps it,
/// and searches it.
fn reindexed_hits(dir: &Path, query: &str) -> Vec<String> {
    let data = Connection::open(dir.join("data.db")).expect("a second data.db handle");
    let mut index = Connection::open(dir.join("index.db")).expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    search::reindex(&data, &index, now_ms()).expect("reindex");
    search::search(&data, &index, query, &search::SearchFilter::default(), 20)
        .map(|groups| [groups.notes, groups.journals].concat())
        .expect("search")
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

/// The record lands and owes its body; the body pull finds an empty log; the
/// text typed afterwards comes down the feed; search finds it.
async fn typed_after_an_empty_pull(id: &str, item_type: &str) {
    let (dir, db) = scratch(item_type);

    feed(
        &db,
        vec![
            response(
                200,
                &json!({"items": [{"id": id, "type": item_type}], "deleted": [], "hasMore": false, "nextCursor": 5, "noteBodies": []}).to_string(),
            ),
            response(200, &json!({"items": [envelope(id, item_type)]}).to_string()),
        ],
        id,
        item_type,
    )
    .pull_page()
    .await
    .expect("the record page");
    assert_eq!(
        db.call_blocking(|conn| body_debt::owed(conn))
            .expect("owed"),
        [id],
        "the record owes its body"
    );

    let pulled = body_step::run(&db, &body_pull(&db, FakeTransport::new(empty_log())))
        .await
        .expect("the body step");
    assert_eq!(pulled.updates, 0, "nothing typed yet");
    assert!(
        db.call_blocking(|conn| body_debt::owed(conn))
            .expect("owed")
            .is_empty(),
        "an empty log at the head settles the debt"
    );

    let typed = body_update(&format!("I jotted down the router password {WORD} here."));
    let report = feed(
        &db,
        vec![response(
            200,
            &json!({
                "items": [],
                "deleted": [],
                "hasMore": false,
                "nextCursor": 6,
                "noteBodies": [{
                    "op": "update",
                    "noteId": id,
                    "cursor": 6,
                    "sequenceNum": 1,
                    "signerDeviceId": "device-b",
                    "createdAt": 1_760_000_000,
                    "size": 10,
                    "data": BASE64.encode(&typed),
                }],
            })
            .to_string(),
        )],
        id,
        item_type,
    )
    .pull_page()
    .await
    .expect("the body page");

    assert_eq!(report.advanced_documents, [id], "the feed landed the body");
    assert_eq!(reindexed_hits(&dir, WORD), [id]);
}

#[tokio::test]
async fn a_journal_typed_after_an_empty_body_pull_is_found_by_search() {
    typed_after_an_empty_pull(JOURNAL, "journal").await;
}

#[tokio::test]
async fn a_note_typed_after_an_empty_body_pull_is_found_by_search() {
    typed_after_an_empty_pull(NOTE, "note").await;
}

/// An install the bug already reached: the record is here, its debt settled,
/// no body cursor and no log rows. The next pass owes and pulls it once, with
/// no user action, and a pass after that does not sweep again.
#[tokio::test]
async fn an_install_left_without_body_state_heals_on_the_next_pass() {
    let (dir, db) = scratch("heal");
    db.call_blocking(|conn| {
        for (item_type, id) in [("journal", JOURNAL), ("note", NOTE)] {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: item_type.to_owned(),
                    item_id: id.to_owned(),
                    payload_json: payload(item_type),
                    server_cursor: Some(5),
                    signer_device_id: Some("device-b".to_owned()),
                    updated_at: 1,
                    deleted_at: None,
                },
                1,
            )?;
        }
        Ok::<_, StorageError>(())
    })
    .expect("the broken install");
    assert_eq!(reindexed_hits(&dir, WORD), Vec::<String>::new());

    let typed = body_update(&format!("I jotted down the router password {WORD} here."));
    let mut script = Vec::new();
    // Swept in id order: the journal's log holds the text, the note's is empty.
    script.push(response(200, &json!({"snapshot": null}).to_string()));
    script.push(response(
        200,
        &json!({"updates": [{"sequenceNum": 1, "data": BASE64.encode(&typed), "signerDeviceId": "device-b", "createdAt": 1}], "hasMore": false}).to_string(),
    ));
    script.extend(empty_log());
    let transport = FakeTransport::new(script);
    let healed = body_step::run(&db, &body_pull(&db, transport.clone()))
        .await
        .expect("the healing pass");

    assert_eq!(healed.documents, 2, "{healed:?}");
    assert!(
        db.call_blocking(|conn| body_debt::owed(conn))
            .expect("owed")
            .is_empty()
    );
    assert_eq!(reindexed_hits(&dir, WORD), [JOURNAL]);

    let again = body_step::run(&db, &body_pull(&db, FakeTransport::new(Vec::new())))
        .await
        .expect("the next pass");
    assert_eq!(again.documents, 0, "the sweep runs once: {again:?}");
}

/// The orchestrator's case: a note whose body this device already pulled and
/// indexed gets a body-only edit on desktop, with no record change. The edit
/// arrives through the feed as an update, or as a snapshot over the same
/// sequence, and search finds the new word after the next reindex.
async fn an_existing_note_edited_on_desktop(
    edit: impl Fn(
        &[u8],
    ) -> (
        Json,
        Vec<Result<HttpResponse, memry_core::api::errors::TransportError>>,
    ),
) {
    let (dir, db) = scratch("existing");
    feed(
        &db,
        vec![
            response(
                200,
                &json!({"items": [{"id": NOTE, "type": "note"}], "deleted": [], "hasMore": false, "nextCursor": 5, "noteBodies": []}).to_string(),
            ),
            response(200, &json!({"items": [envelope(NOTE, "note")]}).to_string()),
        ],
        NOTE,
        "note",
    )
    .pull_page()
    .await
    .expect("the record page");
    let draft = Doc::with_client_id(99);
    let fragment = draft.get_or_insert_xml_fragment("prosemirror");
    let paragraph = {
        let mut txn = draft.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"))
    };
    paragraph.insert(
        &mut draft.transact_mut(),
        0,
        XmlTextPrelim::new("First draft."),
    );
    let first = draft
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    body_step::run(
        &db,
        &body_pull(
            &db,
            FakeTransport::new(vec![
                response(200, &json!({"snapshot": null}).to_string()),
                response(
                    200,
                    &json!({"updates": [{"sequenceNum": 1, "data": BASE64.encode(&first), "signerDeviceId": "device-b", "createdAt": 1}], "hasMore": false}).to_string(),
                ),
            ]),
        ),
    )
    .await
    .expect("the body step");
    assert_eq!(
        reindexed_hits(&dir, "draft"),
        [NOTE],
        "indexed before the edit"
    );

    let before = draft.transact().state_vector();
    paragraph.insert(
        &mut draft.transact_mut(),
        1,
        XmlTextPrelim::new(format!(" {WORD}")),
    );
    let delta = draft.transact().encode_state_as_update_v1(&before);
    let full = draft
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let (entry, mut script) = edit(&full);
    let entry = if entry.is_null() {
        json!({"op": "update", "noteId": NOTE, "cursor": 6, "sequenceNum": 2, "signerDeviceId": "device-b", "createdAt": 1_760_000_000, "size": 10, "data": BASE64.encode(&delta)})
    } else {
        entry
    };
    let mut page = vec![response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 6, "noteBodies": [entry]}).to_string(),
    )];
    page.append(&mut script);
    let report = feed(&db, page, NOTE, "note")
        .pull_page()
        .await
        .expect("the edit page");

    assert_eq!(
        report.advanced_documents,
        [NOTE],
        "the feed landed the edit"
    );
    assert_eq!(reindexed_hits(&dir, WORD), [NOTE]);
}

#[tokio::test]
async fn an_existing_note_body_only_update_is_found_by_search() {
    an_existing_note_edited_on_desktop(|_| (Json::Null, Vec::new())).await;
}

#[tokio::test]
async fn an_existing_note_body_only_snapshot_is_found_by_search() {
    an_existing_note_edited_on_desktop(|full| {
        (
            json!({"op": "snapshot", "noteId": NOTE, "cursor": 6, "sequenceNum": 1, "signerDeviceId": "device-b", "createdAt": 1_760_000_000, "size": 10, "revision": "rev-2"}),
            vec![response(
                200,
                &json!({"snapshot": BASE64.encode(full), "sequenceNum": 1, "signerDeviceId": "device-b", "revision": "rev-2"}).to_string(),
            )],
        )
    })
    .await;
}
