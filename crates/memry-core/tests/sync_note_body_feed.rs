//! Note bodies from the change feed (chapter 07 §7.17, chapter 05 §5.11.1;
//! #2295, #2297, #2304).
//!
//! Real `HttpClient`, SQLite, update log and `yrs`; the transport and the two
//! ciphers are the fakes. The body cipher hands the packed bytes back as the
//! plaintext, or fails on the bytes `bad`, so an entry's `data` is base64 of
//! the update it carries.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use memry_core::sync::body_pull::{CrdtCipher, PackedUpdate, crdt_cursor_scope};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL;
use memry_core::sync::pull::{
    META_CURSOR_SKIP_REPAIR, META_RECORD_DECLARATION, PullLoop, PullReport, RecordCipher,
};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};
use yrs::{GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE_A: &str = "notea1234567";
const NOTE_B: &str = "noteb1234567";
const NOTE_C: &str = "notec1234567";
const NOTE_D: &str = "noted1234567";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-note-body-feed-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct NoRecords;

impl RecordCipher for NoRecords {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if update.packed == b"bad" {
            return Err(EnvelopeError::SignatureInvalid);
        }
        Ok(update.packed.to_vec())
    }
}

/// A real Yjs update writing `text` into a document of its own.
fn an_update(text: &str) -> Vec<u8> {
    let doc = yrs::Doc::with_client_id(42);
    let body = doc.get_or_insert_text("t");
    body.insert(&mut doc.transact_mut(), 0, text);
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn data(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

fn update_entry(doc_id: &str, cursor: i64, sequence_num: i64, bytes: Option<&[u8]>) -> Json {
    let mut entry = json!({
        "op": "update",
        "noteId": doc_id,
        "cursor": cursor,
        "sequenceNum": sequence_num,
        "signerDeviceId": "device-b",
        "createdAt": 1_760_000_000,
        "size": 10,
    });
    if let Some(bytes) = bytes {
        entry["data"] = json!(data(bytes));
    }
    entry
}

fn snapshot_entry(doc_id: &str, cursor: i64, revision: &str) -> Json {
    json!({
        "op": "snapshot",
        "noteId": doc_id,
        "cursor": cursor,
        "sequenceNum": 3,
        "signerDeviceId": "device-b",
        "createdAt": 1_760_000_000,
        "size": 10,
        "revision": revision,
    })
}

fn body_page(entries: Vec<Json>, deleted: &[&str], next_cursor: i64) -> String {
    json!({
        "items": [],
        "deleted": deleted,
        "hasMore": false,
        "nextCursor": next_cursor,
        "noteBodies": entries,
    })
    .to_string()
}

fn feed(db: &Db, transport: Arc<FakeTransport>) -> PullLoop {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoRecords),
    )
    .with_note_bodies(Arc::new(PassThrough))
}

/// A device that has pulled under today's declaration, with the cursor-skip
/// repair and the legacy body pull behind it.
fn seed_cursor(db: &Db, cursor: &str) {
    let cursor = cursor.to_owned();
    db.call_blocking(move |conn| {
        store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some(&cursor), 1)?;
        for (key, value) in [
            (
                META_RECORD_DECLARATION,
                Declaration::subscribed().header_value(),
            ),
            (META_CURSOR_SKIP_REPAIR, "done".to_owned()),
            (META_NOTE_BODY_LEGACY_PULL, "done".to_owned()),
        ] {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [key, value.as_str()],
            )
            .map_err(failed)?;
        }
        Ok(())
    })
    .expect("seed the device");
}

/// A document this device holds body state for: a `crdt:<docId>` cursor at
/// `at`. The feed lands bodies only for these (#2297 review B-4).
fn hold(db: &Db, doc_id: &str, at: &str) {
    let scope = crdt_cursor_scope(doc_id);
    let at = at.to_owned();
    db.call_blocking(move |conn| store::write_cursor(conn, &scope, Some(&at), 1))
        .expect("a held body");
}

/// A device whose server has not served bodies yet.
fn forget_legacy_pull(db: &Db) {
    db.call_blocking(|conn| {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            [META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(failed)
    })
    .expect("the legacy pull not yet owed");
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn stored_cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

fn body_cursor(db: &Db, doc_id: &str) -> Option<String> {
    let scope = crdt_cursor_scope(doc_id);
    db.call_blocking(move |conn| store::read_cursor(conn, &scope))
        .expect("read the body cursor")
}

fn stored_sequences(db: &Db, doc_id: &str) -> Vec<i64> {
    let doc_id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        let mut statement = conn
            .prepare("SELECT seq FROM yjs_updates WHERE doc_id = ?1 ORDER BY seq")
            .map_err(failed)?;
        let rows = statement
            .query_map([&doc_id], |row| row.get::<_, i64>(0))
            .map_err(failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failed)?;
        Ok(rows)
    })
    .expect("read the log")
}

fn owed(db: &Db) -> Vec<String> {
    db.call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents")
}

fn meta(db: &Db, key: &'static str) -> Option<String> {
    db.call_blocking(move |conn| read_meta(conn, key))
        .expect("read meta")
}

async fn pull(
    db: &Db,
    script: Vec<
        Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError>,
    >,
) -> (Arc<FakeTransport>, PullReport) {
    let transport = FakeTransport::new(script);
    let report = feed(db, transport.clone())
        .pull_page()
        .await
        .expect("the page");
    (transport, report)
}

/// #2297: the feed declares `note_body` on `/sync/changes` only, and an inline
/// update lands, parsed and in the update log, before the page's cursor. An
/// id with no local note is stored and nothing else.
#[tokio::test]
async fn an_inline_update_lands_before_the_cursor_and_the_feed_declares_note_body() {
    let db = scratch_db("inline");
    seed_cursor(&db, "10");
    hold(&db, NOTE_A, "0");
    forget_legacy_pull(&db);
    let update = an_update("hello");

    let (transport, report) = pull(
        &db,
        vec![response(
            200,
            &body_page(vec![update_entry(NOTE_A, 11, 1, Some(&update))], &[], 11),
        )],
    )
    .await;

    let declared = transport.calls()[0].headers["x-memry-sync-types"].clone();
    assert!(declared.ends_with(",note_body"), "{declared}");
    assert_eq!(
        declared.trim_end_matches(",note_body"),
        Declaration::subscribed().header_value(),
        "the record declaration is unchanged, so the feed does not restart"
    );
    assert!(!report.refused);
    assert_eq!(report.advanced_documents, [NOTE_A]);
    assert_eq!(stored_cursor(&db).as_deref(), Some("11"));
    assert_eq!(stored_sequences(&db, NOTE_A), [1]);
    assert_eq!(body_cursor(&db, NOTE_A).as_deref(), Some("1"));
    assert_eq!(
        owed(&db),
        [NOTE_A],
        "the one-time legacy pull owes every held document"
    );
    assert_eq!(
        meta(&db, META_NOTE_BODY_LEGACY_PULL).as_deref(),
        Some("done"),
        "the server serves bodies, so the legacy pull is owed once, as debts"
    );
    let created_at: i64 = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT created_at FROM yjs_updates WHERE doc_id = ?1",
                [NOTE_A],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the row");
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    assert!(
        created_at > 1_760_000_000_000 && created_at <= now_ms,
        "this device's epoch-ms clock at landing, as the per-note pull stores it, so the \
         search index re-reads the row: {created_at}"
    );

    // The update in the log is the one the entry carried.
    let plan = db
        .call_blocking(|conn| {
            update_log::load_plan(conn, NOTE_A).map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the load plan");
    let doc = yrs::Doc::new();
    let text = doc.get_or_insert_text("t");
    for blob in plan.blobs() {
        use yrs::updates::decoder::Decode as _;
        doc.transact_mut()
            .apply_update(yrs::Update::decode_v1(blob).expect("decode"))
            .expect("apply");
    }
    assert_eq!(text.get_string(&doc.transact()), "hello");
}

/// #2297 review: `note_body` carries journal bodies under the same key, so a
/// journal body edit lands through the feed, and a deleted journal's body is
/// dropped like a note's.
#[tokio::test]
async fn a_journal_body_lands_through_the_feed_and_a_deleted_journal_drops_it() {
    const JOURNAL: &str = "j2026-09-25";
    const OLD_JOURNAL: &str = "j2026-09-24";
    let db = scratch_db("journal");
    seed_cursor(&db, "10");
    hold(&db, JOURNAL, "0");
    hold(&db, OLD_JOURNAL, "0");
    db.call_blocking(|conn| store::mark_deleted(conn, "journal", OLD_JOURNAL, 5, None, 5))
        .expect("an earlier journal delete");

    let (_transport, report) = pull(
        &db,
        vec![response(
            200,
            &body_page(
                vec![
                    update_entry(JOURNAL, 11, 1, Some(&an_update("today"))),
                    update_entry(OLD_JOURNAL, 12, 1, Some(&an_update("ghost"))),
                ],
                &[],
                12,
            ),
        )],
    )
    .await;

    assert!(!report.refused);
    assert_eq!(report.advanced_documents, [JOURNAL]);
    assert_eq!(stored_sequences(&db, JOURNAL), [1]);
    assert_eq!(body_cursor(&db, JOURNAL).as_deref(), Some("1"));
    assert!(stored_sequences(&db, OLD_JOURNAL).is_empty());
    assert_eq!(stored_cursor(&db).as_deref(), Some("12"));
}

/// #2297, §5.14: each entry is its own. A malformed entry, one this device
/// cannot open and one that is not a Yjs update each cost that entry and owe
/// its note a whole-body pull; the good entry lands and the page advances.
#[tokio::test]
async fn one_bad_entry_costs_that_entry_and_owes_its_note_never_the_page() {
    let db = scratch_db("bad-entries");
    seed_cursor(&db, "10");
    for doc in [NOTE_A, NOTE_B, NOTE_C, NOTE_D] {
        hold(&db, doc, "0");
    }
    let good = an_update("good");

    let (_transport, report) = pull(
        &db,
        vec![response(
            200,
            &body_page(
                vec![
                    json!({"op": "reshape", "noteId": NOTE_B, "cursor": 11}),
                    json!({"op": "update", "cursor": 12}),
                    update_entry(NOTE_C, 13, 1, Some(b"bad")),
                    update_entry(NOTE_D, 14, 1, Some(b"not a yjs update")),
                    update_entry(NOTE_A, 15, 1, Some(&good)),
                ],
                &[],
                15,
            ),
        )],
    )
    .await;

    assert!(!report.refused);
    assert_eq!(stored_cursor(&db).as_deref(), Some("15"));
    assert_eq!(stored_sequences(&db, NOTE_A), [1]);
    assert!(stored_sequences(&db, NOTE_C).is_empty());
    assert!(
        stored_sequences(&db, NOTE_D).is_empty(),
        "parsed before it is stored"
    );
    assert_eq!(owed(&db), [NOTE_B, NOTE_C, NOTE_D]);
}

/// #2297, §7.17.1 and §7.17.2: a ref update is fetched by sequence. One that
/// follows the held body cursor lands and moves it; one the server pruned is
/// skipped and its note owed; a fetch that fails owes its note and the page
/// still advances.
#[tokio::test]
async fn a_ref_update_is_fetched_by_sequence_and_a_pruned_or_failed_one_is_owed() {
    let db = scratch_db("refs");
    seed_cursor(&db, "10");
    hold(&db, NOTE_B, "0");
    hold(&db, NOTE_C, "0");
    db.call_blocking(|conn| store::write_cursor(conn, &crdt_cursor_scope(NOTE_A), Some("4"), 1))
        .expect("a held body cursor");
    let update = an_update("big");

    let (transport, report) = pull(
        &db,
        vec![
            response(
                200,
                &body_page(
                    vec![
                        update_entry(NOTE_A, 11, 5, None),
                        update_entry(NOTE_B, 12, 3, None),
                        update_entry(NOTE_C, 13, 2, None),
                    ],
                    &[],
                    13,
                ),
            ),
            response(
                200,
                &json!({"updates": [{"sequenceNum": 5, "data": data(&update), "signerDeviceId": "device-b"}], "hasMore": false}).to_string(),
            ),
            response(200, &json!({"updates": [], "hasMore": false}).to_string()),
            response(404, r#"{"error":{"code":"NOT_FOUND","message":"gone"}}"#),
        ],
    )
    .await;

    let urls: Vec<String> = transport.calls().into_iter().map(|call| call.url).collect();
    assert_eq!(
        urls[1],
        format!("https://sync.example/sync/crdt/updates?note_id={NOTE_A}&since=4&limit=1")
    );
    assert!(!report.refused);
    assert_eq!(stored_cursor(&db).as_deref(), Some("13"));
    assert_eq!(stored_sequences(&db, NOTE_A), [5]);
    assert_eq!(body_cursor(&db, NOTE_A).as_deref(), Some("5"));
    assert_eq!(owed(&db), [NOTE_B, NOTE_C]);
}

/// #2297, §7.9: an update past a gap in the body cursor is stored, the cursor
/// does not step over the gap, and the note is owed the whole-body pull that
/// fetches what is missing.
#[tokio::test]
async fn an_update_past_a_gap_is_stored_and_owed_without_moving_the_body_cursor() {
    let db = scratch_db("gap");
    seed_cursor(&db, "10");
    hold(&db, NOTE_A, "0");
    let update = an_update("later");

    pull(
        &db,
        vec![response(
            200,
            &body_page(vec![update_entry(NOTE_A, 11, 7, Some(&update))], &[], 11),
        )],
    )
    .await;

    assert_eq!(stored_sequences(&db, NOTE_A), [7]);
    assert_eq!(body_cursor(&db, NOTE_A).as_deref(), Some("0"));
    assert_eq!(owed(&db), [NOTE_A]);
}

/// #2297, §7.17.1: a snapshot entry naming the revision held costs no
/// request; another is fetched and stored under its revision.
#[tokio::test]
async fn a_snapshot_ref_is_fetched_unless_its_revision_is_held() {
    let db = scratch_db("snapshots");
    seed_cursor(&db, "10");
    hold(&db, NOTE_B, "0");
    let held = an_update("held");
    db.call_blocking(move |conn| {
        update_log::put_server_snapshot(conn, NOTE_A, &held, 3, Some("rev-held"), 1).map_err(
            |error| StorageError::Failed {
                what: error.to_string(),
            },
        )
    })
    .expect("a held snapshot");
    let fresh = an_update("fresh");

    let (transport, report) = pull(
        &db,
        vec![
            response(
                200,
                &body_page(
                    vec![
                        snapshot_entry(NOTE_A, 11, "rev-held"),
                        snapshot_entry(NOTE_B, 12, "rev-b"),
                    ],
                    &[],
                    12,
                ),
            ),
            response(
                200,
                &json!({"snapshot": data(&fresh), "sequenceNum": 9, "revision": "rev-b2", "signerDeviceId": "device-b"}).to_string(),
            ),
        ],
    )
    .await;

    assert_eq!(transport.call_count(), 2, "one snapshot GET, for NOTE_B");
    assert!(
        transport.calls()[1]
            .url
            .ends_with(&format!("/sync/crdt/snapshot/{NOTE_B}"))
    );
    assert_eq!(report.advanced_documents, [NOTE_B]);
    let stored = db
        .call_blocking(|conn| {
            update_log::snapshot(conn, Namespace::Server, NOTE_B).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("read")
        .expect("the fetched snapshot");
    assert_eq!(stored.server_revision.as_deref(), Some("rev-b2"));
    assert_eq!(stored.last_seq, 9);
    assert_eq!(body_cursor(&db, NOTE_B).as_deref(), Some("9"));
    assert!(owed(&db).is_empty());
}

/// #2297, §7.17.1 and §7.15: bodies of a note this page deletes cost no
/// request and are dropped, and so are bodies of a note deleted here before.
#[tokio::test]
async fn bodies_of_a_deleted_note_are_dropped() {
    let db = scratch_db("deleted");
    seed_cursor(&db, "10");
    hold(&db, NOTE_A, "0");
    hold(&db, NOTE_C, "0");
    db.call_blocking(|conn| store::mark_deleted(conn, "note", NOTE_C, 5, None, 5))
        .expect("an earlier delete");
    let update = an_update("ghost");

    let (transport, _report) = pull(
        &db,
        vec![
            response(
                200,
                &body_page(
                    vec![
                        update_entry(NOTE_A, 11, 1, None),
                        update_entry(NOTE_C, 12, 1, Some(&update)),
                    ],
                    &[NOTE_A],
                    12,
                ),
            ),
            // §5.12: the deleted id goes to `/sync/pull` with the page.
            response(200, &json!({"items": []}).to_string()),
        ],
    )
    .await;

    assert_eq!(
        transport.calls_to("/sync/crdt/updates").len(),
        0,
        "no fetch for a deleted note"
    );
    assert!(stored_sequences(&db, NOTE_A).is_empty());
    assert!(stored_sequences(&db, NOTE_C).is_empty());
    assert!(owed(&db).is_empty());
    assert_eq!(stored_cursor(&db).as_deref(), Some("12"));
}

/// #2297, §5.11: the bodies, their debts and the cursor are one transaction.
/// A body that cannot be stored fails the page with the cursor where it was,
/// so the page and its bodies are pulled again.
#[tokio::test]
async fn a_body_that_cannot_be_stored_never_lets_the_cursor_pass_it() {
    let db = scratch_db("atomic");
    seed_cursor(&db, "10");
    forget_legacy_pull(&db);
    hold(&db, NOTE_A, "0");
    hold(&db, NOTE_B, "0");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER refuse_bodies BEFORE INSERT ON yjs_updates
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .map_err(failed)
    })
    .expect("a store that refuses bodies");
    let update = an_update("lost?");

    let transport = FakeTransport::new(vec![response(
        200,
        &body_page(
            vec![
                update_entry(NOTE_B, 11, 1, Some(b"bad")),
                update_entry(NOTE_A, 12, 1, Some(&update)),
            ],
            &[],
            12,
        ),
    )]);
    let failed_page = feed(&db, transport).pull_page().await;

    assert!(failed_page.is_err(), "the page fails as a whole");
    assert_eq!(stored_cursor(&db).as_deref(), Some("10"));
    assert!(owed(&db).is_empty(), "the debts rolled back with it");
    assert_eq!(meta(&db, META_NOTE_BODY_LEGACY_PULL), None);
}

/// #2297: a pull without `note_body` declares nothing new, and a server that
/// does not serve bodies leaves the legacy pull unstarted.
#[tokio::test]
async fn a_loop_without_note_bodies_keeps_the_record_declaration() {
    let db = scratch_db("undeclared");
    seed_cursor(&db, "10");
    forget_legacy_pull(&db);
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 11}).to_string(),
    )]);
    let http = HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoRecords),
    )
    .pull_page()
    .await
    .expect("the page");

    assert_eq!(
        transport.calls()[0].headers["x-memry-sync-types"],
        Declaration::subscribed().header_value()
    );
    assert_eq!(meta(&db, META_NOTE_BODY_LEGACY_PULL), None);
}

/// #2297 review A-4/B-3: an update at or below the held `crdt:<docId>` cursor
/// is a replay. It costs no request and no decrypt, so a full re-read of the
/// feed does not fetch or open what this device already holds.
#[tokio::test]
async fn entries_at_or_below_the_held_body_cursor_cost_no_request_or_decrypt() {
    let db = scratch_db("replays");
    seed_cursor(&db, "10");
    hold(&db, NOTE_A, "5");

    let (transport, report) = pull(
        &db,
        vec![response(
            200,
            &body_page(
                vec![
                    update_entry(NOTE_A, 11, 4, None),
                    // `bad` fails to open: it is owed only if it is opened.
                    update_entry(NOTE_A, 12, 5, Some(b"bad")),
                ],
                &[],
                12,
            ),
        )],
    )
    .await;

    assert_eq!(transport.call_count(), 1, "no fetch for a held update");
    assert!(owed(&db).is_empty(), "no decrypt of a held update");
    assert!(report.advanced_documents.is_empty());
    assert_eq!(stored_cursor(&db).as_deref(), Some("12"));
}

/// #2297 review B-3: after the first `429` of a page no further request goes
/// out. Every entry still needing one owes its document, and the page still
/// advances.
#[tokio::test]
async fn after_a_429_the_page_sends_no_further_request_and_owes_the_rest() {
    let db = scratch_db("rate-limited");
    seed_cursor(&db, "10");
    for doc in [NOTE_B, NOTE_C, NOTE_D] {
        hold(&db, doc, "0");
    }

    let (transport, report) = pull(
        &db,
        vec![
            response(
                200,
                &body_page(
                    vec![
                        update_entry(NOTE_B, 11, 1, None),
                        update_entry(NOTE_C, 12, 1, None),
                        snapshot_entry(NOTE_D, 13, "rev-d"),
                    ],
                    &[],
                    13,
                ),
            ),
            response(
                429,
                r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
            ),
        ],
    )
    .await;

    assert_eq!(transport.call_count(), 2, "one fetch, then none");
    assert!(!report.refused);
    assert_eq!(owed(&db), [NOTE_B, NOTE_C, NOTE_D]);
    assert_eq!(stored_cursor(&db).as_deref(), Some("13"));
}

/// #2297 review B-4, A-3/B-5: a document this device holds no body state for
/// gets nothing from the feed, neither a row nor a debt. It is fetched whole
/// when it is opened or when its record arrives, so it never reads as present
/// with a partial body, and the body of a note deleted elsewhere long ago
/// never lands on a device that never held it.
#[tokio::test]
async fn a_document_with_no_body_state_gets_no_feed_body() {
    let db = scratch_db("unknown");
    seed_cursor(&db, "10");
    let update = an_update("never fetched");

    let (transport, report) = pull(
        &db,
        vec![response(
            200,
            &body_page(
                vec![
                    update_entry(NOTE_A, 11, 50, Some(&update)),
                    update_entry(NOTE_A, 12, 51, None),
                    snapshot_entry(NOTE_A, 13, "rev-a"),
                ],
                &[],
                13,
            ),
        )],
    )
    .await;

    assert_eq!(
        transport.call_count(),
        1,
        "no fetch for an unknown document"
    );
    assert!(stored_sequences(&db, NOTE_A).is_empty());
    assert_eq!(body_cursor(&db, NOTE_A), None);
    assert!(owed(&db).is_empty());
    assert!(report.advanced_documents.is_empty());
    assert_eq!(stored_cursor(&db).as_deref(), Some("13"));
}

/// #2297 review B-8: a page that deletes a tag whose id equals a note's id
/// deletes no body, so the note's body entry still lands.
#[tokio::test]
async fn a_deleted_tag_sharing_a_note_id_does_not_drop_the_note_body() {
    let db = scratch_db("tag-collision");
    seed_cursor(&db, "10");
    hold(&db, NOTE_A, "0");
    let update = an_update("kept");
    let tag_tombstone = json!({
        "id": NOTE_A,
        "type": "tag_definition",
        "operation": "delete",
        "deletedAt": 5,
        "signature": "AAAA",
        "signerDeviceId": "device-b",
        "blob": {"encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA", "dataNonce": "AAAA"},
    });

    pull(
        &db,
        vec![
            response(
                200,
                &body_page(
                    vec![update_entry(NOTE_A, 11, 1, Some(&update))],
                    &[NOTE_A],
                    11,
                ),
            ),
            response(200, &json!({ "items": [tag_tombstone] }).to_string()),
        ],
    )
    .await;

    assert_eq!(stored_sequences(&db, NOTE_A), [1]);
}
