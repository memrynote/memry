//! Unknown fields and unknown types, against real adapters (T135, SC-014,
//! FR-032, FR-033).
//!
//! Real `HttpClient`, real SQLite, real repositories, the real pull loop and
//! the real push wave. The only fakes are the two seams the core deliberately
//! does not own: the `Transport` (Constitution I) and the record cipher.
//! **Nothing here reaches a network.**
//!
//! Two obligations, and they pull against each other, which is why they are in
//! one file:
//!
//! - **An unknown _field_ must survive** (chapter 13 §13.2's five rules,
//!   §13.3's forward tolerance, §13.4's absent-versus-null). A key this build
//!   does not model is not a problem to be handled; it is another device's
//!   data, and the edit cycle has to give it back unchanged.
//! - **An unknown _type_ must not survive silently** (chapter 05 §5.3.1). It is
//!   recorded corrupt, never applied, and never dropped — because the page's
//!   cursor advances past it either way (§5.14), and an item the cursor passed
//!   without recording is an item nobody will ever look for again.
//!
//! §5.3.1 names the second one the defensive case and the first one the live
//! one, and this phase found three bugs of exactly the first shape: a
//! `filter_map` over `GET /sync/vaults` that reported "no vaults" for an
//! account holding four, a `tag_definition.icon: null` recorded corrupt 146
//! times, and a stale remote record overwriting a newer local one for eleven
//! types. All three were invisible to a unit test and visible here.

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::domain::notes;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::{Declaration, UNSUBSCRIBED_RECORD_ITEM_TYPES};
use memry_core::storage::repositories::sync_items::{self, PAYLOAD_STATE_METADATA_ONLY};
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};

const NOW: i64 = 1_760_000_000_000;
const NOTE_ID: &str = "abc123def456";

/// A `note` payload a **newer desktop** wrote.
///
/// Four keys this build has never heard of, chosen to be the four shapes that
/// have actually gone wrong: a nested object (`coverImage`, whose own
/// `fit` this build would not model either), an array that desktop is on
/// record as losing (`linkedCanvasIds`,
/// `task-handler.ts:278-284`), an **explicit null** on an unmodelled key
/// (`bannerColour` — the `tag_definition.icon: null` shape, §13.4), and a
/// twice-nested object (`sourceApp.build`).
const NEWER_DESKTOP_NOTE: &str = concat!(
    r#"{"title":"A note","fileType":"markdown","folderPath":"Notes","#,
    r#""clock":{"device-b":1},"#,
    r#""coverImage":{"url":"memry://cover/1","offsetY":0.25,"fit":"cover"},"#,
    r#""linkedCanvasIds":["canvas-7"],"#,
    r#""bannerColour":null,"#,
    r#""sourceApp":{"name":"desktop","build":{"channel":"beta","number":4471}}}"#
);

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-unknown-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Hands back a scripted plaintext per id, and records every id it was asked
/// to open — so a test can assert which bodies were **not** decrypted.
struct ScriptedCipher {
    plaintexts: Vec<(String, String)>,
    opened: Mutex<Vec<String>>,
}

impl ScriptedCipher {
    fn new(plaintexts: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            plaintexts: plaintexts
                .iter()
                .map(|(id, payload)| ((*id).to_owned(), (*payload).to_owned()))
                .collect(),
            opened: Mutex::new(Vec::new()),
        })
    }

    fn opened(&self) -> Vec<String> {
        self.opened.lock().unwrap().clone()
    }
}

impl RecordCipher for ScriptedCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.opened.lock().unwrap().push(envelope.id.clone());
        self.plaintexts
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

/// Records the plaintext the wave chose, so a test can assert **which bytes**
/// left the device.
#[derive(Default)]
struct RecordingSealer {
    sealed: Mutex<Vec<String>>,
}

impl RecordingSealer {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn sealed(&self) -> Vec<String> {
        self.sealed.lock().unwrap().clone()
    }
}

impl PushSealer for RecordingSealer {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        let payload = item.row.payload.clone().unwrap_or_default();
        self.sealed.lock().unwrap().push(payload.clone());
        Ok(json!({
            "id": item.row.item_id,
            "type": item.row.item_type,
            "operation": item.operation.as_str(),
            "encryptedData": payload,
        }))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

/// A `POST /sync/pull` item: chapter 05 §5.11.1's read shape.
fn pull_item(id: &str, item_type: &str) -> Json {
    json!({
        "id": id,
        "type": item_type,
        "operation": "update",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
        "blob": {
            "encryptedKey": "AAAA",
            "keyNonce": "AAAA",
            "encryptedData": "AAAA",
            "dataNonce": "AAAA",
        },
    })
}

fn changes_page(refs: &[(&str, &str)], next_cursor: &str, has_more: bool) -> String {
    let items: Vec<Json> = refs
        .iter()
        .map(|(id, item_type)| json!({"id": id, "type": item_type}))
        .collect();
    json!({
        "items": items,
        "deleted": [],
        "hasMore": has_more,
        "nextCursor": next_cursor,
    })
    .to_string()
}

fn pull_loop(db: &Db, transport: Arc<FakeTransport>, cipher: Arc<dyn RecordCipher>) -> PullLoop {
    PullLoop::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        cipher,
    )
}

fn raw_payload(db: &Db, item_type: &str, item_id: &str) -> String {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    db.call_blocking(move |conn| sync_items::push_payload(conn, &item_type, &item_id))
        .expect("read the row")
        .expect("a stored payload")
}

fn row(db: &Db, item_type: &str, item_id: &str) -> Option<sync_items::SyncItemRow> {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    db.call_blocking(move |conn| sync_items::load(conn, &item_type, &item_id))
        .expect("read the row")
}

fn projected_notes(db: &Db) -> Vec<(String, String)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT id, title FROM notes ORDER BY id")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        Ok(rows)
    })
    .expect("the note projections")
}

/// One page of `GET /sync/changes` followed by one `POST /sync/pull`.
async fn pull_one_page(
    db: &Db,
    refs: &[(&str, &str)],
    items: Vec<Json>,
    plaintexts: &[(&str, &str)],
    cursor: &str,
    has_more: bool,
) -> (PullReport, Arc<ScriptedCipher>) {
    let transport = FakeTransport::new(vec![
        response(200, &changes_page(refs, cursor, has_more)),
        response(200, &json!({ "items": items }).to_string()),
    ]);
    let cipher = ScriptedCipher::new(plaintexts);
    let report = pull_loop(db, transport, cipher.clone())
        .pull_page()
        .await
        .expect("the page");
    (report, cipher)
}

// ------------------------------------- FR-033: an unknown field survives

/// **SC-014 and FR-033, end to end**: pull a payload a newer desktop wrote,
/// edit it here, and every key this build cannot model comes back out of the
/// push unchanged.
///
/// Three stages, each of which desktop fails at today (#2183, §13.2.1):
///
/// 1. **stored verbatim** — the unedited path returns the received bytes, not
///    a re-encoding, so the byte-for-byte round trip §12.4.3 pins never goes
///    near a serialiser;
/// 2. **merged, not rebuilt** — the local rename merges into a parsed copy
///    (§13.2 rule 3) instead of re-serialising the projection row (rule 4);
/// 3. **pushed from the live row** — §6.5.2's P2, so what leaves the device is
///    the merged bytes rather than whatever the outbox froze at enqueue.
///
/// The loop matters: if any stage re-derived the payload from the columns, the
/// four unmodelled keys would be gone from the server the next time this device
/// touched the note — which is precisely how `linkedCanvasIds` is lost on
/// desktop.
#[tokio::test]
async fn a_newer_desktop_payload_survives_an_edit_cycle_with_its_unmodelled_keys_intact() {
    let db = scratch_db("edit-cycle");

    let (report, _cipher) = pull_one_page(
        &db,
        &[(NOTE_ID, "note")],
        vec![pull_item(NOTE_ID, "note")],
        &[(NOTE_ID, NEWER_DESKTOP_NOTE)],
        "41",
        false,
    )
    .await;
    assert_eq!(report.applied, 1);
    assert_eq!(
        report.corrupt, 0,
        "§13.3: a key this build does not model is not a schema failure"
    );

    // Stage 1. Byte for byte: the unedited path never re-serialises.
    assert_eq!(
        raw_payload(&db, "note", NOTE_ID),
        NEWER_DESKTOP_NOTE,
        "§13.2 rule 1: the decrypted bytes are stored exactly as received"
    );
    assert_eq!(
        projected_notes(&db),
        vec![(NOTE_ID.to_owned(), "A note".to_owned())],
        "and the projection is a cache of a parse, downstream of those bytes"
    );

    // Stage 2. A real local edit through the real domain path.
    db.call_blocking(|conn| notes::rename(conn, NOTE_ID, "Renamed here", "device-a", NOW))
        .expect("the rename");

    let received: Json = serde_json::from_str(NEWER_DESKTOP_NOTE).expect("the received payload");
    let after: Json =
        serde_json::from_str(&raw_payload(&db, "note", NOTE_ID)).expect("the merged payload");
    assert_eq!(after["title"], json!("Renamed here"));

    // Every key the edit did not name is byte-identical to what arrived. The
    // loop is the assertion: a key added by a future desktop is covered by it
    // without this test being edited.
    let touched = ["title", "clock", "modifiedAt"];
    for (key, value) in received.as_object().expect("an object") {
        if touched.contains(&key.as_str()) {
            continue;
        }
        assert_eq!(
            after.get(key),
            Some(value),
            "the edit dropped or rewrote `{key}`"
        );
    }

    // And named, so a failure says which shape broke.
    assert_eq!(
        after["coverImage"],
        json!({"url": "memry://cover/1", "offsetY": 0.25, "fit": "cover"}),
        "a nested unmodelled object, including its own unmodelled key"
    );
    assert_eq!(after["linkedCanvasIds"], json!(["canvas-7"]));
    assert_eq!(
        after["sourceApp"]["build"],
        json!({"channel": "beta", "number": 4471})
    );
    // §13.4: `null` is an explicit clear and absence is not. Dropping the key
    // would tell every peer "I do not know this field" and let an older value
    // come back.
    assert!(
        after.get("bannerColour").is_some(),
        "§13.4: an explicit null must not degrade into an absent key"
    );
    assert!(after["bannerColour"].is_null());

    // The edit is publishable: §6.1's tick advanced without disturbing the
    // peer's, or the rename would lose to the payload it was made against.
    assert_eq!(after["clock"], json!({"device-a": 1, "device-b": 1}));

    // Stage 3. The real push wave, reading the live row at send time.
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"accepted": [NOTE_ID], "rejected": [], "serverTime": 1, "maxCursor": 1})
            .to_string(),
    )]);
    let sealer = RecordingSealer::new();
    let coordinator = PushCoordinator::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        sealer.clone(),
    );
    coordinator.drain_wave().await.expect("the wave");

    let sealed = sealer.sealed();
    assert_eq!(sealed.len(), 1, "one push item for the renamed note");
    assert_eq!(
        sealed[0],
        raw_payload(&db, "note", NOTE_ID),
        "§6.5.2 P2: the wire payload is the live row's bytes, not a rebuild"
    );
    let pushed: Json = serde_json::from_str(&sealed[0]).expect("the pushed payload");
    assert_eq!(pushed["coverImage"], received["coverImage"]);
    assert_eq!(pushed["linkedCanvasIds"], received["linkedCanvasIds"]);
    assert!(
        pushed.get("bannerColour").is_some() && pushed["bannerColour"].is_null(),
        "the explicit null reaches the server as a null"
    );
    assert_eq!(pushed["sourceApp"], received["sourceApp"]);
}

// ------------------------- FR-032: an unknown type is recorded, not dropped

/// **The assertion this task exists for**: a page carrying a type this client
/// did not declare neither fails the page nor lets the cursor pass unprocessed
/// work.
///
/// §5.3.1 is explicit and its two halves are easy to implement separately and
/// wrongly. A client MUST treat an undeclared type as a **corrupt item and
/// record it**, MUST NOT apply it, and the page's cursor still advances
/// (§5.14). So "the cursor does not pass unprocessed work" cannot mean the
/// cursor stops — it means the work is **written down at its own id, with its
/// own feed position**, before the cursor moves past it. A `filter_map` that
/// dropped the item would satisfy "does not fail the page" and lose the item
/// for ever, which is the `GET /sync/vaults` bug in another place.
///
/// `canvas` is one of the twelve recognised types this client does not
/// subscribe to (chapter 13 §13.1), asserted below rather than assumed.
#[tokio::test]
async fn an_unsubscribed_type_is_recorded_against_its_id_rather_than_dropped_from_the_page() {
    assert!(
        UNSUBSCRIBED_RECORD_ITEM_TYPES.contains(&"canvas"),
        "this test is about a recognised type this client does not declare"
    );
    let db = scratch_db("unsubscribed-type");

    let mut unsubscribed = pull_item("canvas1", "canvas");
    unsubscribed["serverCursor"] = json!(4711);
    // §13.2.2: a newer server may add an envelope key, and a client MUST NOT
    // reject an item for carrying one.
    let mut newer_envelope = pull_item("def456abc123", "note");
    newer_envelope["vaultShard"] = json!(3);

    let (report, cipher) = pull_one_page(
        &db,
        &[
            (NOTE_ID, "note"),
            ("canvas1", "canvas"),
            ("def456abc123", "note"),
        ],
        vec![pull_item(NOTE_ID, "note"), unsubscribed, newer_envelope],
        &[
            (NOTE_ID, NEWER_DESKTOP_NOTE),
            (
                "def456abc123",
                r#"{"title":"Second","fileType":"markdown"}"#,
            ),
        ],
        "77",
        false,
    )
    .await;

    // The page did not fail: both page mates applied, and the unsubscribed
    // item is one item's worth of trouble (§5.14, validation is per item).
    assert_eq!(report.applied, 2);
    assert_eq!(report.corrupt, 1);
    assert_eq!(report.deleted, 0);
    assert_eq!(report.skipped, 0);
    assert!(
        !report.refused,
        "§5.14's breaker needs a page that yielded nothing; this one yielded two"
    );
    assert_eq!(report.cursor.as_deref(), Some("77"));
    assert_eq!(
        projected_notes(&db),
        vec![
            (NOTE_ID.to_owned(), "A note".to_owned()),
            ("def456abc123".to_owned(), "Second".to_owned()),
        ],
        "the unknown envelope key did not cost the item that carried it"
    );

    // The unsubscribed item is **recorded**, which is what makes the cursor's
    // advance safe: the id, the type, the reason and the feed position are all
    // on disk, so a build that later declares `canvas` can find it again.
    let recorded = row(&db, "canvas", "canvas1").expect("a row for the unsubscribed item");
    let reason = recorded
        .corrupt_reason
        .as_deref()
        .expect("§5.3.1: recorded, not skipped");
    assert!(
        reason.contains("undeclared item type") && reason.contains("canvas"),
        "the reason names what happened: {reason}"
    );
    assert!(recorded.corrupt_at.is_some());
    assert_eq!(
        recorded.server_cursor,
        Some(4711),
        "the item's own feed position is kept, so the global cursor moving past it loses nothing"
    );

    // Not applied: no payload, no projection, and the body was never opened.
    assert_eq!(recorded.payload_state, PAYLOAD_STATE_METADATA_ONLY);
    assert!(
        recorded.payload.is_none(),
        "§5.3.1: recorded, never applied"
    );
    assert_eq!(
        cipher.opened(),
        vec![NOTE_ID.to_owned(), "def456abc123".to_owned()],
        "an undeclared type is refused before it is decrypted"
    );
}

/// The other half of §5.14, on the same cause: a page whose **only** item is
/// an unsubscribed type advances the cursor **and** refuses the run.
///
/// Both halves or neither. Advancing without refusing loses the page silently;
/// refusing without advancing wedges the device on it for ever. The refusal
/// then stops the loop: the transport is scripted with one page's worth of
/// responses and `hasMore` is `true`, so a loop that carried on would ask for
/// a page that is not there and panic.
#[tokio::test]
async fn a_page_of_nothing_but_an_unsubscribed_type_refuses_the_run_and_still_advances() {
    let db = scratch_db("unsubscribed-only");
    let transport = FakeTransport::new(vec![
        response(200, &changes_page(&[("canvas1", "canvas")], "88", true)),
        response(
            200,
            &json!({ "items": [pull_item("canvas1", "canvas")] }).to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[]);
    let report = pull_loop(&db, transport.clone(), cipher)
        .run(5)
        .await
        .expect("the run");

    assert_eq!(report.pages, 1, "the refusal stopped the loop");
    assert_eq!(report.corrupt, 1);
    assert_eq!(
        report.applied + report.deleted + report.skipped + report.expired,
        0
    );
    assert!(report.refused, "§5.14: no success state may be written");
    assert_eq!(
        report.cursor.as_deref(),
        Some("88"),
        "§5.14: and the cursor still advances, or the device wedges here for ever"
    );
    assert_eq!(
        transport.call_count(),
        2,
        "one /sync/changes and one /sync/pull; a refused run asks for nothing more"
    );

    // Still recorded, even on the page that refused.
    let recorded = row(&db, "canvas", "canvas1").expect("a row for the unsubscribed item");
    assert!(recorded.corrupt_reason.is_some());
}

/// A device that pulled under an older, narrower declaration starts the feed
/// over once, so rows of a newly declared type (saved filters) that sit
/// behind its cursor arrive; the next run keeps its cursor.
#[tokio::test]
async fn a_wider_declaration_restarts_the_feed_once() {
    use memry_core::sync::first_sync_store::read_meta;
    use memry_core::sync::pull::META_RECORD_DECLARATION;
    use memry_core::sync::store::{RECORD_CURSOR_SCOPE, write_cursor};

    let db = scratch_db("declaration");
    db.call_blocking(|conn| write_cursor(conn, RECORD_CURSOR_SCOPE, Some("500"), 1))
        .expect("an old cursor");

    let transport = FakeTransport::new(vec![
        response(200, &changes_page(&[], "600", false)),
        response(200, &changes_page(&[], "600", false)),
    ]);
    let cipher = ScriptedCipher::new(&[]);
    let pull = pull_loop(&db, transport.clone(), cipher);
    pull.run(5).await.expect("the restarted run");
    pull.run(5).await.expect("the next run");

    let urls: Vec<String> = transport
        .calls()
        .iter()
        .map(|call| call.url.clone())
        .collect();
    assert!(
        !urls[0].contains("cursor="),
        "restarted from the start: {urls:?}"
    );
    assert!(
        urls[1].contains("cursor=600"),
        "then kept its place: {urls:?}"
    );
    let stored = db
        .call_blocking(|conn| read_meta(conn, META_RECORD_DECLARATION))
        .expect("meta");
    assert_eq!(stored, Some(Declaration::subscribed().header_value()));
}
