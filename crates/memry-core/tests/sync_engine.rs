//! The pull loop and the engine state machine, against real adapters.
//!
//! Real `HttpClient`, real SQLite, real repositories. The only fakes are the
//! three seams the core deliberately does not own: the `Transport`, which is a
//! foreign trait by construction (Constitution I), reachability, and the
//! record cipher, whose key directory is a later task's. **Nothing here
//! reaches a network.**
//!
//! What each test pins:
//!
//! | Test                                | Rule                                        |
//! | ----------------------------------- | ------------------------------------------- |
//! | apply order and cursor              | chapter 05 §5.11, §5.13                    |
//! | one malformed item                  | §5.14, §13.2 rule 5, FR-032, data-model §D.3 |
//! | the page breaker                    | §5.14, both halves                          |
//! | tombstones                          | §5.12, §5.12.1                              |
//! | inline payloads on the first page   | §5.11.2, #2292                              |
//! | a pull body that is not an envelope | §5.14, #2285                                |
//! | the drawn edges of every pass       | data-model §C.3                             |
//! | blocked policy parks the outbox     | chapter 11 §11.9                            |
//! | two passes serialised               | §C.3, "two concurrent passes race the cursor" |
//! | the push payload rebuilt at send    | chapter 06 §6.5.2 P2 and P3                 |

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::ApiError;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::settings;
use memry_core::domain::tasks;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::repositories::Change;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::{PassReport, PushWave, SyncEngine};
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::state::{PassTrigger, SyncState, WriteGate, is_drawn};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A scratch `data.db`. Integration tests cannot see the crate's own
/// `test_support`, so the directory is built and left for the OS to reap.
fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-sync-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// A cipher that hands back a scripted plaintext per item id, and records
/// every id it was asked to open.
struct ScriptedCipher {
    plaintexts: Mutex<Vec<(String, String)>>,
    opened: Mutex<Vec<String>>,
}

impl ScriptedCipher {
    fn new(plaintexts: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            plaintexts: Mutex::new(
                plaintexts
                    .iter()
                    .map(|(id, payload)| ((*id).to_owned(), (*payload).to_owned()))
                    .collect(),
            ),
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
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

struct FixedReachability(Reachable);

impl Reachability for FixedReachability {
    fn current(&self) -> Reachable {
        self.0
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// An outbox that reports a queue and answers `drain` from a script.
struct ScriptedPush {
    pending: usize,
    result: Mutex<Option<ApiError>>,
    drains: AtomicUsize,
}

impl ScriptedPush {
    fn queued(pending: usize) -> Arc<Self> {
        Arc::new(Self {
            pending,
            result: Mutex::new(None),
            drains: AtomicUsize::new(0),
        })
    }

    fn rejecting(pending: usize, error: ApiError) -> Arc<Self> {
        Arc::new(Self {
            pending,
            result: Mutex::new(Some(error)),
            drains: AtomicUsize::new(0),
        })
    }

    fn drains(&self) -> usize {
        self.drains.load(Ordering::Relaxed)
    }
}

#[async_trait::async_trait]
impl PushWave for ScriptedPush {
    async fn pending(&self) -> Result<usize, ApiError> {
        Ok(self.pending)
    }

    async fn drain(&self) -> Result<(), ApiError> {
        self.drains.fetch_add(1, Ordering::Relaxed);
        match self.result.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// A pull envelope with every field chapter 04 §4.6 requires.
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
        "signerDeviceId": "device-a",
    })
}

fn tombstone(id: &str, item_type: &str, deleted_at: i64) -> Json {
    let mut item = envelope(id, item_type);
    // §5.12: a present `deletedAt` overrides the declared operation, so the
    // operation is deliberately left as `update`.
    item["deletedAt"] = json!(deleted_at);
    item
}

fn changes(ids: &[(&str, &str)], deleted: &[&str], next_cursor: &str) -> String {
    let items: Vec<Json> = ids
        .iter()
        .map(|(id, item_type)| json!({"id": id, "type": item_type}))
        .collect();
    json!({
        "items": items,
        "deleted": deleted,
        "hasMore": false,
        "nextCursor": next_cursor,
    })
    .to_string()
}

fn loop_for(transport: Arc<FakeTransport>, db: Db, cipher: Arc<dyn RecordCipher>) -> PullLoop {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PullLoop::new(Arc::new(http), db, Declaration::subscribed(), cipher)
}

fn assert_every_edge_is_drawn(report: &PassReport, from: SyncState) {
    let mut current = from;
    for next in &report.transitions {
        assert!(
            is_drawn(current, *next),
            "data-model §C.3 draws no edge from {current:?} to {next:?}"
        );
        current = *next;
    }
    assert_eq!(current, report.final_state);
}

// --------------------------------------------------------------- the tests

#[tokio::test]
async fn a_page_applies_in_rank_order_and_advances_the_cursor_only_afterwards() {
    let db = scratch_db("apply-order");
    // The wire order is task-then-project; §5.13 ranks `project` 0 and `task`
    // 2, so the project must be applied first whatever order it arrived in.
    let transport = FakeTransport::new(vec![
        response(
            200,
            &changes(&[("task-1", "task"), ("project-1", "project")], &[], "17"),
        ),
        response(
            200,
            &json!({"items": [envelope("task-1", "task"), envelope("project-1", "project")]})
                .to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[
        ("task-1", r#"{"title":"Ship it"}"#),
        ("project-1", r#"{"name":"Phase 3"}"#),
    ]);
    let pull = loop_for(transport, db.clone(), cipher.clone());

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.applied, 2);
    assert_eq!(report.corrupt, 0);
    assert!(!report.refused);
    assert_eq!(report.cursor.as_deref(), Some("17"));
    assert_eq!(
        cipher.opened(),
        ["task-1", "project-1"],
        "decoding happens on arrival; the rank orders the apply, not the decode"
    );

    db.call_blocking(|conn| {
        assert_eq!(
            store::read_cursor(conn, RECORD_CURSOR_SCOPE)?,
            Some("17".to_owned())
        );
        let title: String = conn
            .query_row("SELECT title FROM tasks WHERE id = 'task-1'", [], |row| {
                row.get(0)
            })
            .expect("the task projection");
        assert_eq!(title, "Ship it");
        Ok(())
    })
    .expect("read back");
}

#[tokio::test]
async fn one_malformed_item_never_poisons_its_page_mates() {
    let db = scratch_db("failure-isolation");
    // §5.14: schema validation is per item, not per page. The bad item is
    // missing `signature`, which `envelope::from_json` refuses.
    let mut broken = envelope("note-bad", "note");
    broken.as_object_mut().unwrap().remove("signature");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &changes(&[("note-bad", "note"), ("note-good", "note")], &[], "42"),
        ),
        response(
            200,
            &json!({"items": [broken, envelope("note-good", "note")]}).to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[("note-good", r#"{"title":"Survivor"}"#)]);
    let pull = loop_for(transport, db.clone(), cipher);

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.applied, 1, "the good page mate still applied");
    assert_eq!(report.corrupt, 1);
    assert!(
        !report.refused,
        "the page yielded something, so the breaker does not trip"
    );
    assert_eq!(report.cursor.as_deref(), Some("42"));

    db.call_blocking(|conn| {
        // §13.2 rule 5: recorded as corrupt, not silently skipped.
        let row = sync_items::load(conn, "note", "note-bad")?.expect("the corrupt row exists");
        assert!(row.corrupt_reason.is_some(), "{row:?}");
        assert!(sync_items::load(conn, "note", "note-good")?.is_some());
        Ok(())
    })
    .expect("read back");
}

#[tokio::test]
async fn the_breaker_refuses_the_run_and_still_advances_the_cursor() {
    let db = scratch_db("breaker");
    let mut broken = envelope("note-bad", "note");
    broken.as_object_mut().unwrap().remove("signature");
    let transport = FakeTransport::new(vec![
        response(200, &changes(&[("note-bad", "note")], &[], "99")),
        response(200, &json!({"items": [broken]}).to_string()),
    ]);
    let pull = loop_for(transport, db.clone(), ScriptedCipher::new(&[]));

    let report = pull.pull_page().await.expect("the page");
    // Both halves. Advancing without refusing loses data silently; refusing
    // without advancing wedges the device on one poisoned page forever.
    assert!(report.refused, "the run is unsuccessful");
    assert_eq!(report.cursor.as_deref(), Some("99"), "and the cursor moved");
    assert_eq!(report.applied, 0);
    assert_eq!(report.corrupt, 1);

    db.call_blocking(|conn| {
        assert_eq!(
            store::read_cursor(conn, RECORD_CURSOR_SCOPE)?,
            Some("99".to_owned())
        );
        Ok(())
    })
    .expect("read back");
}

#[tokio::test]
async fn a_tombstone_is_applied_without_its_body_ever_being_decoded() {
    let db = scratch_db("tombstones");
    let transport = FakeTransport::new(vec![
        // §5.12: the client unions `deleted` into the pull for the same page.
        response(200, &changes(&[], &["note-1", "never-seen"], "5")),
        response(
            200,
            // The server answers with the typed tombstone and says nothing
            // about the second id, which §5.12.1 makes an untyped delete.
            &json!({"items": [tombstone("note-1", "note", 1_700_000_000_000i64)]}).to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[]);
    let pull = loop_for(transport, db.clone(), cipher.clone());

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.deleted, 2);
    assert_eq!(report.corrupt, 0);
    assert!(!report.refused);
    assert!(
        cipher.opened().is_empty(),
        "tombstone bodies are never decoded"
    );

    db.call_blocking(|conn| {
        let row = sync_items::load(conn, "note", "note-1")?.expect("the tombstoned row");
        assert_eq!(row.deleted_at, Some(1_700_000_000_000));
        assert!(row.payload.is_none());
        // §5.12.1: an id with no ref row and no typed item is recorded, so a
        // later pull of it cannot resurrect it locally.
        assert!(store::has_bare_tombstone(conn, "never-seen")?);
        Ok(())
    })
    .expect("read back");
}

// ------------------------------------ inline payloads and a bad pull body

fn seed_cursor(db: &Db, cursor: &str) {
    let cursor = cursor.to_owned();
    db.call_blocking(move |conn| {
        store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some(&cursor), 1)?;
        // `run` restarts the feed when no declaration was recorded.
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            [
                memry_core::sync::pull::META_RECORD_DECLARATION,
                Declaration::subscribed().header_value().as_str(),
            ],
        )
        .expect("record the declaration");
        // ... and the one-time cursor-skip repair (#2382) ran long ago.
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::pull::META_CURSOR_SKIP_REPAIR],
        )
        .expect("record the repair");
        Ok(())
    })
    .expect("seed the cursor");
}

fn stored_cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

fn urls(transport: &FakeTransport) -> Vec<String> {
    transport.calls().into_iter().map(|call| call.url).collect()
}

/// The ids a `POST /sync/pull` asked for.
fn pulled_ids(transport: &FakeTransport) -> Vec<Vec<String>> {
    transport
        .calls_to("/sync/pull")
        .into_iter()
        .map(|call| {
            let body: Json = serde_json::from_slice(&call.body.expect("a body")).expect("json");
            serde_json::from_value(body["itemIds"].clone()).expect("itemIds")
        })
        .collect()
}

/// #2292: the first page of an incremental pull asks `inline=1`, applies what
/// arrived inline, and pulls only the page ids no inline element names. An
/// inline element that fails its envelope is corrupt, never re-pulled.
#[tokio::test]
async fn an_incremental_first_page_applies_inline_items_and_pulls_only_the_rest() {
    let db = scratch_db("inline-mixed");
    seed_cursor(&db, "10");
    let mut broken = envelope("note-bad", "note");
    broken.as_object_mut().unwrap().remove("signature");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({
                "items": [
                    {"id": "note-a", "type": "note"},
                    {"id": "note-b", "type": "note"},
                    {"id": "note-bad", "type": "note"},
                ],
                "deleted": ["note-gone"],
                "hasMore": false,
                "nextCursor": 20,
                "inline": [
                    envelope("note-a", "note"),
                    broken,
                    tombstone("note-gone", "note", 1_700_000_000_000i64),
                ],
            })
            .to_string(),
        ),
        response(
            200,
            &json!({"items": [envelope("note-b", "note")]}).to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[
        ("note-a", r#"{"title":"Inline"}"#),
        ("note-b", r#"{"title":"Pulled"}"#),
    ]);
    let pull = loop_for(transport.clone(), db.clone(), cipher);

    let report = pull.pull_first_page().await.expect("the page");
    assert_eq!(report.applied, 2);
    assert_eq!(report.deleted, 1);
    assert_eq!(report.corrupt, 1);
    assert!(!report.refused);
    assert_eq!(stored_cursor(&db).as_deref(), Some("20"));

    assert!(
        urls(&transport)[0].ends_with("/sync/changes?limit=500&cursor=10&inline=1"),
        "{:?}",
        urls(&transport)
    );
    assert_eq!(
        pulled_ids(&transport),
        vec![vec!["note-b".to_owned()]],
        "only the id no inline element named"
    );
    db.call_blocking(|conn| {
        assert!(sync_items::load(conn, "note", "note-a")?.is_some());
        let gone = sync_items::load(conn, "note", "note-gone")?.expect("the tombstone");
        assert_eq!(gone.deleted_at, Some(1_700_000_000_000));
        let bad = sync_items::load(conn, "note", "note-bad")?.expect("the corrupt row");
        assert!(bad.corrupt_reason.is_some());
        Ok(())
    })
    .expect("read back");
}

/// #2292: a page that arrived entirely inline costs one request.
#[tokio::test]
async fn an_all_inline_page_makes_no_pull_request() {
    let db = scratch_db("inline-all");
    seed_cursor(&db, "10");
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({
            "items": [{"id": "note-a", "type": "note"}],
            "deleted": [],
            "hasMore": false,
            "nextCursor": 11,
            "inline": [envelope("note-a", "note")],
        })
        .to_string(),
    )]);
    let cipher = ScriptedCipher::new(&[("note-a", r#"{"title":"Inline"}"#)]);
    let pull = loop_for(transport.clone(), db.clone(), cipher);

    let report = pull.pull_first_page().await.expect("the page");
    assert_eq!(report.applied, 1);
    assert_eq!(transport.call_count(), 1, "no POST /sync/pull");
    assert_eq!(stored_cursor(&db).as_deref(), Some("11"));
}

/// #2292: only a run's first page asks, and a server that ignores the query
/// (no `inline` key) is pulled exactly as before.
#[tokio::test]
async fn only_the_first_page_of_an_incremental_run_asks_inline() {
    let db = scratch_db("inline-first-page");
    seed_cursor(&db, "10");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({
                "items": [{"id": "note-a", "type": "note"}],
                "deleted": [],
                "hasMore": true,
                "nextCursor": 20,
            })
            .to_string(),
        ),
        response(
            200,
            &json!({"items": [envelope("note-a", "note")]}).to_string(),
        ),
        response(200, &changes(&[], &[], "30")),
    ]);
    let cipher = ScriptedCipher::new(&[("note-a", r#"{"title":"Old server"}"#)]);
    let pull = loop_for(transport.clone(), db.clone(), cipher);

    let report = pull.run(5).await.expect("the run");
    assert_eq!(report.applied, 1);
    assert_eq!(pulled_ids(&transport), vec![vec!["note-a".to_owned()]]);
    let urls = urls(&transport);
    assert!(urls[0].ends_with("&cursor=10&inline=1"), "{urls:?}");
    assert!(urls[2].ends_with("&cursor=20"), "{urls:?}");
    assert_eq!(stored_cursor(&db).as_deref(), Some("30"));
}

/// #2292: with no stored cursor the pull reads the feed from the start, which
/// is backlog, so it keeps 500-ref pages (protocol 05 §5.11.2).
#[tokio::test]
async fn a_pull_with_no_stored_cursor_does_not_ask_inline() {
    let db = scratch_db("inline-no-cursor");
    let transport = FakeTransport::new(vec![response(200, &changes(&[], &[], "5"))]);
    let pull = loop_for(transport.clone(), db.clone(), ScriptedCipher::new(&[]));

    pull.pull_first_page().await.expect("the page");
    assert!(urls(&transport)[0].ends_with("/sync/changes?limit=500"));
}

/// #2285: a `/sync/pull` body that is not a pull envelope is a server
/// contract regression. The page is not applied, the cursor holds so the page
/// is still there to re-pull once the server is fixed, and the run is refused.
#[tokio::test]
async fn a_pull_response_that_is_not_an_envelope_holds_the_cursor_and_refuses_the_run() {
    let db = scratch_db("not-an-envelope");
    seed_cursor(&db, "10");
    let transport = FakeTransport::new(vec![
        response(200, &changes(&[("note-a", "note")], &[], "20")),
        response(200, &json!({"unexpected": true}).to_string()),
    ]);
    let cipher = ScriptedCipher::new(&[("note-a", r#"{"title":"x"}"#)]);
    let pull = loop_for(transport.clone(), db.clone(), cipher);

    // `run` stops at the refusal: a third request would run off the script.
    let report = pull.run(5).await.expect("the run");
    assert!(report.refused, "the run is unsuccessful");
    assert_eq!(report.dropped_pages, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.cursor.as_deref(), Some("10"));
    assert_eq!(
        stored_cursor(&db).as_deref(),
        Some("10"),
        "the cursor did not move past the page"
    );
    assert_eq!(transport.call_count(), 2);
}

/// #2285 with #2292: a bad remainder pull refuses the page even when some of
/// it arrived inline, and nothing from the page is applied.
#[tokio::test]
async fn a_non_envelope_remainder_refuses_the_page_even_with_inline_items() {
    let db = scratch_db("inline-bad-remainder");
    seed_cursor(&db, "10");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({
                "items": [{"id": "note-a", "type": "note"}, {"id": "note-b", "type": "note"}],
                "deleted": [],
                "hasMore": false,
                "nextCursor": 20,
                "inline": [envelope("note-a", "note")],
            })
            .to_string(),
        ),
        response(200, "[]"),
    ]);
    let cipher = ScriptedCipher::new(&[
        ("note-a", r#"{"title":"x"}"#),
        ("note-b", r#"{"title":"y"}"#),
    ]);
    let pull = loop_for(transport.clone(), db.clone(), cipher);

    let report = pull.pull_first_page().await.expect("the page");
    assert!(report.refused);
    assert_eq!(report.applied, 0);
    assert_eq!(stored_cursor(&db).as_deref(), Some("10"));
    db.call_blocking(|conn| {
        assert!(sync_items::load(conn, "note", "note-a")?.is_none());
        Ok(())
    })
    .expect("read back");
}

#[tokio::test]
async fn a_pass_walks_the_edges_c3_draws_and_ends_idle() {
    let db = scratch_db("engine-idle");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(200, &changes(&[("note-1", "note")], &[], "8")),
        response(
            200,
            &json!({"items": [envelope("note-1", "note")]}).to_string(),
        ),
    ]);
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[("note-1", r#"{"title":"One"}"#)]),
    ));
    let push = ScriptedPush::queued(0);
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)))
        .with_push(push.clone());

    let report = engine.run_pass(PassTrigger::Foreground).await;
    assert_eq!(
        report.transitions,
        [SyncState::Pulling, SyncState::Applying, SyncState::Idle]
    );
    assert_every_edge_is_drawn(&report, SyncState::Idle);
    assert_eq!(engine.state(), SyncState::Idle);
    assert_eq!(report.pull.applied, 1);
    assert!(!report.pushed, "an empty outbox never enters Pushing");
    assert_eq!(push.drains(), 0);
}

#[tokio::test]
async fn offline_reachability_parks_the_pass_without_a_single_request() {
    let db = scratch_db("engine-offline");
    let transport = FakeTransport::new(vec![]);
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[]),
    ));
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Offline)));

    let report = engine.run_pass(PassTrigger::Timer).await;
    assert_eq!(report.transitions, [SyncState::Offline]);
    assert_eq!(transport.call_count(), 0);
    assert!(!SyncState::Offline.reads_continue());
}

#[tokio::test]
async fn a_killed_platform_keeps_pulling_and_parks_the_outbox_without_attempting_a_write() {
    let db = scratch_db("engine-readonly");
    let transport = FakeTransport::new(vec![
        // §11.8: learned from `clientPolicy`, with no write attempted.
        response(
            200,
            &json!({"clientPolicy": {"platform": "ios", "writesEnabled": false}}).to_string(),
        ),
        response(200, &changes(&[("note-1", "note")], &[], "3")),
        response(
            200,
            &json!({"items": [envelope("note-1", "note")]}).to_string(),
        ),
    ]);
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[("note-1", r#"{"title":"Readable"}"#)]),
    ));
    let push = ScriptedPush::queued(7);
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)))
        .with_push(push.clone());

    let report = engine.run_pass(PassTrigger::Foreground).await;
    assert_every_edge_is_drawn(&report, SyncState::Idle);
    assert_eq!(report.final_state, SyncState::ReadOnly);
    assert!(report.parked);
    assert_eq!(report.pull.applied, 1, "reads are never gated");
    assert_eq!(push.drains(), 0, "no attempt, so no backoff can accrue");
    assert_eq!(engine.write_gate(), WriteGate::ReadOnly);
}

#[tokio::test]
async fn a_version_below_the_floor_is_blocked_upgrade_and_never_read_only() {
    let db = scratch_db("engine-upgrade");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true, "minWriteVersion": "2.0.0"}})
                .to_string(),
        ),
        response(200, &changes(&[], &[], "1")),
    ]);
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[]),
    ));
    let push = ScriptedPush::queued(2);
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)))
        .with_push(push.clone());

    let report = engine.run_pass(PassTrigger::Foreground).await;
    assert_eq!(report.final_state, SyncState::BlockedUpgrade);
    assert_every_edge_is_drawn(&report, SyncState::Idle);
    // The three blocked states never collapse into one another.
    assert_eq!(
        engine.write_gate(),
        WriteGate::BlockedUpgrade {
            min_version: Some("2.0.0".to_owned())
        }
    );
    assert_eq!(push.drains(), 0);
}

#[tokio::test]
async fn a_mid_wave_403_moves_pushing_to_read_only_rather_than_failed() {
    let db = scratch_db("engine-midwave");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(200, &changes(&[], &[], "1")),
    ]);
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[]),
    ));
    let push = ScriptedPush::rejecting(
        4,
        ApiError::WritesDisabled {
            message: "writes are off for ios".to_owned(),
        },
    );
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)))
        .with_push(push.clone());

    let report = engine.run_pass(PassTrigger::Explicit).await;
    assert!(report.transitions.contains(&SyncState::Pushing));
    assert_eq!(report.final_state, SyncState::ReadOnly);
    assert_every_edge_is_drawn(&report, SyncState::Idle);
    assert_eq!(push.drains(), 1);
    // The next pass parks instead of attempting again.
    assert_eq!(engine.write_gate(), WriteGate::ReadOnly);
}

#[tokio::test]
async fn a_transport_failure_during_a_pull_is_failed_and_exits_to_idle() {
    let db = scratch_db("engine-failed");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        // A 400 is outside the retry ladder (chapter 00 §0.6.1), so one call
        // is all this costs.
        response(400, r#"{"error":{"code":"SYNC_INVALID_CURSOR"}}"#),
        // The second pass: `Failed -> Idle`, then a clean page.
        response(200, &changes(&[], &[], "1")),
    ]);
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[]),
    ));
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)));

    let first = engine.run_pass(PassTrigger::Timer).await;
    assert_eq!(first.final_state, SyncState::Failed);
    assert_every_edge_is_drawn(&first, SyncState::Idle);

    let second = engine.run_pass(PassTrigger::Timer).await;
    assert_eq!(second.transitions[0], SyncState::Idle, "Failed -> Idle");
    assert_every_edge_is_drawn(&second, SyncState::Failed);
    assert_eq!(second.final_state, SyncState::Idle);
}

#[tokio::test]
async fn two_concurrent_passes_serialise_so_the_second_sees_the_first_cursor() {
    let db = scratch_db("engine-serialised");
    // Every response pauses, so an unserialised engine would interleave its
    // two `/sync/changes` calls before either cursor was written.
    let transport = FakeTransport::slow(
        vec![
            response(
                200,
                &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
            ),
            response(200, &changes(&[], &[], "100")),
            response(200, &changes(&[], &[], "200")),
        ],
        20,
    );
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        ScriptedCipher::new(&[]),
    ));
    let engine = Arc::new(SyncEngine::new(
        pull,
        http,
        Arc::new(FixedReachability(Reachable::Wifi)),
    ));

    let (a, b) = tokio::join!(
        engine.run_pass(PassTrigger::Timer),
        engine.run_pass(PassTrigger::SocketHint)
    );
    assert_eq!(a.final_state, SyncState::Idle);
    assert_eq!(b.final_state, SyncState::Idle);

    let urls: Vec<String> = transport.calls().into_iter().map(|call| call.url).collect();
    assert_eq!(urls.len(), 3, "one status poll and two pages: {urls:?}");
    assert!(urls[0].ends_with("/sync/status"));
    assert!(
        urls[1].ends_with("/sync/changes?limit=500"),
        "the first pass started from no cursor: {urls:?}"
    );
    assert!(
        // #2292: a first page with a stored cursor asks for inline payloads.
        urls[2].ends_with("/sync/changes?limit=500&cursor=100&inline=1"),
        "the second pass read the cursor the first one committed: {urls:?}"
    );

    db.call_blocking(|conn| {
        assert_eq!(
            store::read_cursor(conn, RECORD_CURSOR_SCOPE)?,
            Some("200".to_owned())
        );
        Ok(())
    })
    .expect("read back");
}

#[tokio::test]
async fn the_push_payload_is_rebuilt_from_the_live_row_and_a_pull_apply_enqueues_nothing() {
    let db = scratch_db("push-payload");
    let transport = FakeTransport::new(vec![
        response(200, &changes(&[("note-1", "note")], &[], "1")),
        response(
            200,
            &json!({"items": [envelope("note-1", "note")]}).to_string(),
        ),
    ]);
    // A payload carrying a key this build does not model.
    let arrived = r#"{"title":"From a newer build","coverImage":{"url":"memry://cover/1"}}"#;
    let pull = loop_for(
        transport,
        db.clone(),
        ScriptedCipher::new(&[("note-1", arrived)]),
    );
    pull.pull_page().await.expect("the page");

    db.call_blocking(|conn| {
        // §6.5.2 P3: a pull apply never enqueues a push. An enqueue here is
        // the re-push that reintroduces the §6.5.1 case-3c divergence.
        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count the outbox");
        assert_eq!(queued, 0);

        // §6.5.2 P2: the payload a push sends is read from the live row at
        // send time. An outbox that froze it at enqueue would still be
        // holding the pre-edit bytes here.
        assert_eq!(
            sync_items::push_payload(conn, "note", "note-1")?.as_deref(),
            Some(arrived)
        );
        conn.execute(
            "INSERT INTO outbox (item_type, item_id, op, payload, enqueued_at)
             VALUES ('note', 'note-1', 'update', NULL, 1)",
            [],
        )
        .expect("enqueue the key, never the payload");

        let edited = sync_items::apply_local_edit(
            conn,
            "note",
            "note-1",
            &[("title", Change::set("Renamed after the enqueue"))],
            2,
        )?;
        let live = sync_items::push_payload(conn, "note", "note-1")?.expect("the live row");
        assert_eq!(live, edited);
        assert!(live.contains("Renamed after the enqueue"));
        assert!(
            live.contains("coverImage"),
            "the unmodelled key rides along: {live}"
        );
        Ok(())
    })
    .expect("read back");
}

// -------------------------------- the field merge, on the real pull path

/// The moment the two local edits below were made, and the ancestor every
/// remote payload in this section is built from.
const MERGE_NOW: i64 = 1_760_000_000_000;

fn new_task(id: &str) -> memry_core::domain::tasks::NewTask<'_> {
    memry_core::domain::tasks::NewTask {
        id,
        title: "Ship the spec",
        project_id: "proj-1",
        due_date: Some("2026-04-20"),
        due_time: None,
        priority: 2,
        repeat_config: None,
        tags: &[],
    }
}

/// A task created here and retitled here: `clock` reaches `{device-a: 2}` and
/// `title`'s field clock with it, while the other fourteen stay at
/// `{device-a: 1}` (chapter 06 §6.7).
fn seed_locally_edited_task(db: &Db, id: &str) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        tasks::create(conn, &new_task(&id), "device-a", MERGE_NOW)?;
        tasks::set_title(conn, &id, "Local title", "device-a", MERGE_NOW + 1_000)?;
        Ok(())
    })
    .expect("the local edits");
}

fn outbox_rows(db: &Db, item_id: &str) -> i64 {
    let item_id = item_id.to_owned();
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT count(*) FROM outbox WHERE item_id = ?1",
            [&item_id],
            |row| row.get(0),
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("count the queue")
}

fn stored_payload(db: &Db, item_type: &str, item_id: &str) -> Json {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    let raw = db
        .call_blocking(move |conn| sync_items::push_payload(conn, &item_type, &item_id))
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

/// One page carrying exactly one record, opened to `payload`.
async fn pull_one(db: &Db, id: &str, item_type: &str, payload: &str, cursor: &str) -> PullReport {
    let transport = FakeTransport::new(vec![
        response(200, &changes(&[(id, item_type)], &[], cursor)),
        response(
            200,
            &json!({"items": [envelope(id, item_type)]}).to_string(),
        ),
    ]);
    let cipher = ScriptedCipher::new(&[(id, payload)]);
    loop_for(transport, db.clone(), cipher)
        .pull_page()
        .await
        .expect("the page")
}

/// **FR-002 and FR-059, end to end**, and the thing G5 checks against a real
/// desktop: device A changed `title`, device B changed `dueDate`, and both
/// changes are in the row when the pull is done.
///
/// The value of driving the real `/sync/changes` → `/sync/pull` → apply →
/// advance sequence rather than calling `tasks::apply_remote` is the whole
/// point of this test: the merge was written, unit tested and **unreachable**,
/// because the loop routed every type through the wholesale apply. A test one
/// layer down passes either way.
#[tokio::test]
async fn a_concurrent_task_edit_keeps_both_field_changes_through_the_real_pull() {
    let db = scratch_db("pull-task-merge");
    seed_locally_edited_task(&db, "task-1");
    let queued_before = outbox_rows(&db, "task-1");

    // Device B moved the due date from the create's own state, so `dueDate`
    // reaches {device-a: 1, device-b: 1} and `title` stays at {device-a: 1}.
    // The document clocks are concurrent, so §6.3.1 says merge.
    let remote = json!({
        "title": "Ship the spec",
        "dueDate": "2026-05-01",
        "projectId": "proj-1",
        "clock": {"device-a": 1, "device-b": 1},
        "fieldClocks": {
            "title": {"device-a": 1},
            "dueDate": {"device-a": 1, "device-b": 1}
        }
    })
    .to_string();

    let report = pull_one(&db, "task-1", "task", &remote, "21").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.corrupt, 0);
    assert_eq!(report.skipped, 0);
    assert!(!report.refused);
    assert_eq!(report.cursor.as_deref(), Some("21"));

    let parsed = stored_payload(&db, "task", "task-1");
    // FR-059's acceptance: neither edit was lost.
    assert_eq!(
        parsed["title"],
        json!("Local title"),
        "the local title outweighs the remote's older field clock"
    );
    assert_eq!(
        parsed["dueDate"],
        json!("2026-05-01"),
        "the remote due date outweighs the local's older field clock"
    );
    // §6.3 step 7 and §6.3.1: the union, on the document and on the field.
    assert_eq!(parsed["clock"], json!({"device-a": 2, "device-b": 1}));
    assert_eq!(parsed["fieldClocks"]["title"], json!({"device-a": 2}));
    assert_eq!(
        parsed["fieldClocks"]["dueDate"],
        json!({"device-a": 1, "device-b": 1})
    );

    // §6.5.2 P3: the merging device stores the union clock and does **not**
    // re-push. A queue row here is the §6.5.1 case-3c divergence coming back.
    assert_eq!(outbox_rows(&db, "task-1"), queued_before);

    db.call_blocking(|conn| {
        // The projection followed the merge, which is what a UI reads.
        let (title, due): (String, Option<String>) = conn
            .query_row(
                "SELECT title, due_date FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the task projection");
        assert_eq!(title, "Local title");
        assert_eq!(due.as_deref(), Some("2026-05-01"));
        Ok(())
    })
    .expect("read back");
}

/// The second field-merged type takes the same route (§6.8), through the same
/// dispatch, on the same page.
#[tokio::test]
async fn a_concurrent_project_edit_merges_on_the_same_pull_path() {
    let db = scratch_db("pull-project-merge");

    // A project as it arrives the first time: no local clock, so §6.3.1
    // applies it wholesale.
    let first = json!({
        "name": "Native iOS",
        "color": "#0ea5e9",
        "clock": {"device-a": 1},
        "fieldClocks": {"name": {"device-a": 1}, "color": {"device-a": 1}}
    })
    .to_string();
    assert_eq!(
        pull_one(&db, "proj-1", "project", &first, "1")
            .await
            .applied,
        1
    );

    // Then two devices edit different fields of it concurrently: this device
    // renamed it — ticking the document clock and `name`'s field clock, which
    // is what §6.6 says a local edit does — and the remote recoloured it.
    db.call_blocking(|conn| {
        sync_items::apply_local_edit(
            conn,
            "project",
            "proj-1",
            &[
                ("name", Change::set("Renamed here")),
                ("clock", Change::Set(json!({"device-a": 2}))),
                (
                    "fieldClocks",
                    Change::Set(json!({
                        "name": {"device-a": 2},
                        "color": {"device-a": 1}
                    })),
                ),
            ],
            MERGE_NOW,
        )
        .map(|_| ())
    })
    .expect("the local rename");

    let remote = json!({
        "name": "Native iOS",
        "color": "#f97316",
        "clock": {"device-a": 1, "device-b": 1},
        "fieldClocks": {
            "name": {"device-a": 1},
            "color": {"device-a": 1, "device-b": 1}
        }
    })
    .to_string();
    let report = pull_one(&db, "proj-1", "project", &remote, "2").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.corrupt, 0);
    let parsed = stored_payload(&db, "project", "proj-1");
    assert_eq!(parsed["name"], json!("Renamed here"));
    assert_eq!(parsed["color"], json!("#f97316"));
}

/// §6.3.1's skip is **work**, and the page that did it has yielded.
///
/// Counting it as nothing would let one legitimately skipped item on a page
/// with one corrupt one trip §5.14's breaker and refuse a run that processed
/// everything it was given.
#[tokio::test]
async fn a_dominating_local_clock_is_a_skip_and_not_a_refusal() {
    let db = scratch_db("pull-skip");
    seed_locally_edited_task(&db, "task-1");

    // {device-a: 1} against the local {device-a: 2}: the local clock is
    // strictly `after`, so the remote is skipped entirely.
    let remote = json!({
        "title": "Stale remote title",
        "clock": {"device-a": 1},
        "fieldClocks": {"title": {"device-a": 1}}
    })
    .to_string();
    let report = pull_one(&db, "task-1", "task", &remote, "31").await;

    assert_eq!(report.skipped, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.corrupt, 0);
    assert!(!report.refused, "a skip is not nothing");
    assert_eq!(report.cursor.as_deref(), Some("31"));
    assert_eq!(
        stored_payload(&db, "task", "task-1")["title"],
        json!("Local title")
    );
}

/// A merge that cannot proceed is **corrupt with the row kept**, never a
/// silent skip and never an aborted page.
///
/// Letting the error out of the apply would leave the cursor unmoved and wedge
/// the device on this one row forever, which is the failure §5.14's second
/// half exists to prevent.
#[tokio::test]
async fn a_merge_that_cannot_proceed_is_corrupt_and_keeps_the_row() {
    let db = scratch_db("pull-merge-corrupt");
    seed_locally_edited_task(&db, "task-1");

    // A stored `fieldClocks` that will not parse. §6.10: reading it as empty
    // would lower `clockTotal` and hand the next peer every field, so
    // `task_merge` refuses — and that refusal has to land somewhere.
    let local_before = db
        .call_blocking(|conn| {
            let mut payload = stored_json(conn, "task", "task-1");
            payload["fieldClocks"] = json!({"title": {"device-a": "two"}});
            let raw = payload.to_string();
            conn.execute(
                "UPDATE sync_items SET payload = ?1 WHERE item_type = 'task' AND item_id = 'task-1'",
                [&raw],
            )
            .expect("inject the unreadable field clocks");
            Ok(raw)
        })
        .expect("the injected row");

    let remote = json!({
        "title": "Remote title",
        "clock": {"device-b": 1},
        "fieldClocks": {"title": {"device-b": 1}}
    })
    .to_string();
    let report = pull_one(&db, "task-1", "task", &remote, "41").await;

    assert_eq!(report.corrupt, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.skipped, 0);
    // §5.14, both halves: the page produced only corruption, so the run is
    // refused **and** the cursor still advanced past it.
    assert!(report.refused);
    assert_eq!(report.cursor.as_deref(), Some("41"));

    db.call_blocking(move |conn| {
        let row = sync_items::load(conn, "task", "task-1")?.expect("the row is still there");
        assert_eq!(
            row.payload.as_deref(),
            Some(local_before.as_str()),
            "§13.2 rule 5: the bytes are kept, not overwritten by a merge that failed"
        );
        assert!(
            row.corrupt_reason.is_some(),
            "flagged, never a silent skip: {row:?}"
        );
        Ok(())
    })
    .expect("read back");
}

fn stored_json(conn: &rusqlite::Connection, item_type: &str, item_id: &str) -> Json {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

// ------------------------------------- the document-level gate, §6.8's fourth row

/// A note as this device holds it after a local rename: `clock` is
/// `{device-a: 2}`, one tick for the create and one for the rename.
fn seed_locally_renamed_note(db: &Db, id: &str) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        notes::create(
            conn,
            &NewNote {
                id: &id,
                title: "A note",
                folder_path: Some("Notes"),
                content: "",
                tags: &[],
                properties: None,
            },
            "device-a",
            MERGE_NOW,
        )?;
        notes::rename(conn, &id, "Local title", "device-a", MERGE_NOW + 1_000)?;
        Ok(())
    })
    .expect("the local rename");
}

fn projected_note_title(db: &Db, id: &str) -> String {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        conn.query_row("SELECT title FROM notes WHERE id = ?1", [&id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("the note projection")
}

/// The engine's own totals, not the pull loop's.
///
/// `PullLoop::run` accumulated `skipped` correctly and `SyncEngine::pull_pages`
/// did not, so `PassReport.pull.skipped` read 0 no matter how many items
/// §6.3.1's document gate had skipped. Nothing lost data — the cursor and the
/// §5.14 breaker are computed per page inside `pull_page` — but a counter that
/// silently reads zero is how a real skip goes unnoticed in a transcript, and
/// FR-032's vocabulary is the whole point of having four counters.
#[tokio::test]
async fn the_engine_reports_a_skip_rather_than_losing_it_between_pages() {
    let db = scratch_db("engine-skip-total");
    seed_locally_renamed_note(&db, "abc123def456");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(200, &changes(&[("abc123def456", "note")], &[], "51")),
        response(
            200,
            &json!({"items": [envelope("abc123def456", "note")]}).to_string(),
        ),
    ]);
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        ScriptedCipher::new(&[(
            "abc123def456",
            r#"{"title":"Stale remote title","fileType":"markdown","folderPath":"Notes","clock":{"device-a":1}}"#,
        )]),
    ));
    let engine = SyncEngine::new(pull, http, Arc::new(FixedReachability(Reachable::Wifi)));

    let report = engine.run_pass(PassTrigger::Foreground).await;
    assert_eq!(
        report.pull.skipped, 1,
        "the engine must carry the page's skip into its own totals"
    );
    assert_eq!(report.pull.applied, 0);
    assert_eq!(report.pull.corrupt, 0);
}

/// **The data-loss case chapter 06 §6.8 and §6.3.1 exist to prevent**, end to
/// end: rename a note here, then receive a `note` record from a peer that had
/// not seen the rename, and the rename **survives**.
///
/// `note` is not field-merged (§6.8 has exactly two of those), so before the
/// document gate was wired the applier wrote the remote payload
/// unconditionally and the local title was gone. The same held for `template`,
/// `tag_definition`, `tag_category`, `folder_config`, `custom_icon`, `journal`
/// and every other subscribed type.
///
/// Driven through the real `/sync/changes` → `/sync/pull` → apply → advance
/// sequence on purpose: the gate is chosen by the type dispatch, so a test that
/// called the repository directly would pass with the dispatch unwired.
#[tokio::test]
async fn a_stale_remote_note_does_not_clobber_a_newer_local_one() {
    let db = scratch_db("pull-note-skip");
    seed_locally_renamed_note(&db, "abc123def456");
    let queued_before = outbox_rows(&db, "abc123def456");

    // {device-a: 1} against the local {device-a: 2}: `compare` is `after`, so
    // §6.3.1 skips the remote entirely.
    let remote = json!({
        "title": "Stale remote title",
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-a": 1}
    })
    .to_string();
    let report = pull_one(&db, "abc123def456", "note", &remote, "51").await;

    // §6.3.1 row 2, and §5.14: a skip is work, so the page yielded and the
    // cursor advances past it.
    assert_eq!(report.skipped, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.corrupt, 0);
    assert!(!report.refused, "a skip is not nothing");
    assert_eq!(report.cursor.as_deref(), Some("51"));

    let parsed = stored_payload(&db, "note", "abc123def456");
    assert_eq!(
        parsed["title"],
        json!("Local title"),
        "the newer local rename survives the older remote record"
    );
    assert_eq!(
        parsed["clock"],
        json!({"device-a": 2}),
        "nothing was written, so the local clock is untouched"
    );
    assert_eq!(projected_note_title(&db, "abc123def456"), "Local title");
    // §6.5.2 P3: an inbound apply never enqueues, and neither does a skip.
    assert_eq!(outbox_rows(&db, "abc123def456"), queued_before);
}

/// §6.3.1's third row for a type with no per-field merge: the remote payload
/// applies and the **merged** clock is stored.
///
/// Storing the remote's own clock instead would drop `device-a`'s two ticks,
/// lower `clockTotal`, and hand the next concurrent peer a win it did not earn
/// (§6.10).
#[tokio::test]
async fn a_concurrent_note_record_applies_under_the_union_clock() {
    let db = scratch_db("pull-note-merge");
    seed_locally_renamed_note(&db, "abc123def456");
    let queued_before = outbox_rows(&db, "abc123def456");

    // {device-b: 1} against {device-a: 2}: neither dominates, so `compare` is
    // `concurrent`.
    let remote = json!({
        "title": "Remote title",
        "fileType": "markdown",
        "folderPath": "Notes",
        "clock": {"device-b": 1},
        "coverImage": {"url": "memry://cover/1"}
    })
    .to_string();
    let report = pull_one(&db, "abc123def456", "note", &remote, "52").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.skipped, 0);
    assert_eq!(report.corrupt, 0);

    let parsed = stored_payload(&db, "note", "abc123def456");
    assert_eq!(parsed["title"], json!("Remote title"));
    assert_eq!(parsed["clock"], json!({"device-a": 2, "device-b": 1}));
    // §13.2 rule 3: the clock was merged into a parsed copy, so a key this
    // build does not model is still there.
    assert_eq!(parsed["coverImage"], json!({"url": "memry://cover/1"}));
    assert_eq!(projected_note_title(&db, "abc123def456"), "Remote title");
    assert_eq!(outbox_rows(&db, "abc123def456"), queued_before);
}

/// A tombstone bypasses the gate (§6.9.2, §13.7.2): a delete carries no clock,
/// and gating one on a clock it does not have would record it corrupt.
#[tokio::test]
async fn a_delete_for_a_locally_newer_note_is_still_applied() {
    let db = scratch_db("pull-note-delete");
    seed_locally_renamed_note(&db, "abc123def456");

    let transport = FakeTransport::new(vec![
        response(200, &changes(&[("abc123def456", "note")], &[], "53")),
        response(
            200,
            &json!({"items": [tombstone("abc123def456", "note", MERGE_NOW + 2_000)]}).to_string(),
        ),
    ]);
    // The body is never decoded (§5.12), so the cipher has nothing scripted.
    let cipher = ScriptedCipher::new(&[]);
    let report = loop_for(transport, db.clone(), cipher)
        .pull_page()
        .await
        .expect("the page");

    assert_eq!(report.deleted, 1);
    assert_eq!(report.skipped, 0);
    assert_eq!(report.corrupt, 0);
    db.call_blocking(|conn| {
        let row = sync_items::load(conn, "note", "abc123def456")?.expect("the row");
        assert!(row.deleted_at.is_some(), "the delete landed: {row:?}");
        Ok(())
    })
    .expect("read back");
}

// ------------------------------ §6.9's dotted-path field clocks, on the real pull path

/// The one settings item (§13.6).
const SETTINGS_ID: &str = "synced_settings";

/// A vault whose only preference was written **here**: `general.theme` is
/// `"light"` under `{device-a: 2}`, one tick per write (§6.9.1).
fn seed_local_theme(db: &Db) {
    db.call_blocking(|conn| {
        settings::set(conn, "general.theme", json!("dark"), "device-a", MERGE_NOW)?;
        settings::set(
            conn,
            "general.theme",
            json!("light"),
            "device-a",
            MERGE_NOW + 1_000,
        )?;
        Ok(())
    })
    .expect("the local preference");
}

/// One `settings` payload, as §13.7.13 spells it.
fn settings_payload(settings: Json, field_clocks: Json) -> String {
    json!({"settings": settings, "fieldClocks": field_clocks}).to_string()
}

/// The closed ten-group read view, as rows (§13.10.1).
fn projected_settings(db: &Db) -> Vec<(String, String, String)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT \"group\", key, value FROM settings ORDER BY \"group\", key")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        Ok(rows.map(|row| row.expect("row")).collect::<Vec<_>>())
    })
    .expect("the settings projection")
}

/// **The data-loss case §6.9 exists to prevent**, end to end: change the theme
/// here, then receive a settings payload from a peer that had not seen the
/// change, and the theme **survives**.
///
/// Before §6.9 was wired inbound, `apply_settings` stored the remote payload
/// wholesale and the preference silently reverted on the next pull. Driven
/// through the real `/sync/changes` → `/sync/pull` → apply → advance sequence
/// on purpose: the algorithm is chosen by the type dispatch (§6.8), so a test
/// one layer down passes with the dispatch unwired.
#[tokio::test]
async fn a_stale_remote_settings_payload_does_not_clobber_a_newer_local_one() {
    let db = scratch_db("pull-settings-skip");
    seed_local_theme(&db);
    let queued_before = outbox_rows(&db, SETTINGS_ID);

    // {device-a: 1} against the local {device-a: 2}: the local path clock
    // dominates, so every arbitrated path resolves to what is already here.
    let remote = settings_payload(
        json!({"general": {"theme": "dark"}}),
        json!({"general.theme": {"device-a": 1}}),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &remote, "61").await;

    // §5.14: a skip is work, so the page yielded and the cursor advances.
    assert_eq!(report.skipped, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.corrupt, 0);
    assert!(!report.refused, "a skip is not nothing");
    assert_eq!(report.cursor.as_deref(), Some("61"));

    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(
        parsed["settings"]["general"]["theme"],
        json!("light"),
        "the newer local preference survives the older remote payload"
    );
    assert_eq!(
        parsed["fieldClocks"]["general.theme"],
        json!({"device-a": 2}),
        "nothing was written, so the local path clock is untouched"
    );
    assert_eq!(
        projected_settings(&db),
        vec![(
            "general".to_owned(),
            "theme".to_owned(),
            "\"light\"".to_owned()
        )]
    );
    // §6.5.2 P3: an inbound apply never enqueues, and neither does a skip.
    assert_eq!(outbox_rows(&db, SETTINGS_ID), queued_before);
}

/// **FR-059's §6.9 equivalent**: two devices changed two different paths, and
/// one merge keeps both.
///
/// This is the whole reason the clocks are keyed by path rather than by
/// payload. A wholesale store would have replaced the local theme with a
/// payload that never carried one.
#[tokio::test]
async fn two_settings_paths_changed_on_two_devices_both_survive_one_merge() {
    let db = scratch_db("pull-settings-merge");
    seed_local_theme(&db);
    let queued_before = outbox_rows(&db, SETTINGS_ID);

    // Device B never saw `general.theme` and changed the editor font size.
    let remote = settings_payload(
        json!({"editor": {"fontSize": 16}}),
        json!({"editor.fontSize": {"device-b": 1}}),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &remote, "62").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.skipped, 0);
    assert_eq!(report.corrupt, 0);

    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(parsed["settings"]["general"]["theme"], json!("light"));
    assert_eq!(parsed["settings"]["editor"]["fontSize"], json!(16));
    assert_eq!(
        parsed["fieldClocks"],
        json!({
            "general.theme": {"device-a": 2},
            "editor.fontSize": {"device-b": 1}
        }),
        "§6.3 step 7: every arbitrated path carries merge(L, R)"
    );
    assert_eq!(
        projected_settings(&db),
        vec![
            ("editor".to_owned(), "fontSize".to_owned(), "16".to_owned()),
            (
                "general".to_owned(),
                "theme".to_owned(),
                "\"light\"".to_owned()
            ),
        ]
    );
    assert_eq!(outbox_rows(&db, SETTINGS_ID), queued_before);
}

/// §13.10 and FR-063 through the merge branch: a group this build cannot model
/// rides along instead of being stripped.
///
/// Stripping it is #2183's failure mode — a merge that rebuilt the payload from
/// the closed ten-group read view would delete a preference a newer build
/// wrote, on every device, permanently.
#[tokio::test]
async fn an_unmodelled_settings_group_rides_along_through_the_merge() {
    let db = scratch_db("pull-settings-unmodelled");
    seed_local_theme(&db);
    let queued_before = outbox_rows(&db, SETTINGS_ID);

    let remote = settings_payload(
        json!({
            "general": {"theme": "light"},
            "experimental": {"agentSidebar": true}
        }),
        json!({
            "general.theme": {"device-a": 1},
            "experimental.agentSidebar": {"device-b": 1}
        }),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &remote, "63").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.corrupt, 0);

    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(
        parsed["settings"]["experimental"],
        json!({"agentSidebar": true}),
        "the unmodelled group is in the stored bytes a push would send"
    );
    assert_eq!(parsed["settings"]["general"]["theme"], json!("light"));
    assert_eq!(
        parsed["fieldClocks"]["experimental.agentSidebar"],
        json!({"device-b": 1}),
        "and so is its clock: §6.9.1 prunes nothing"
    );
    // The projection stays the closed ten-group read view (§13.10.1).
    assert_eq!(
        projected_settings(&db),
        vec![(
            "general".to_owned(),
            "theme".to_owned(),
            "\"light\"".to_owned()
        )]
    );
    assert_eq!(outbox_rows(&db, SETTINGS_ID), queued_before);
}

/// §6.9.1's removal rule, from the seat that made the removal: a local clear
/// that **ticked** beats a peer still holding the old value, rather than the
/// setting resurrecting on the next pull.
#[tokio::test]
async fn a_local_settings_removal_that_ticked_beats_a_stale_remote_value() {
    let db = scratch_db("pull-settings-removal");
    db.call_blocking(|conn| {
        settings::set(conn, "general.theme", json!("dark"), "device-a", MERGE_NOW)?;
        // A removal is a write and ticks the path (§6.9.1): {device-a: 2}.
        settings::remove(conn, "general.theme", "device-a", MERGE_NOW + 1_000)?;
        Ok(())
    })
    .expect("the local removal");
    let queued_before = outbox_rows(&db, SETTINGS_ID);

    // The peer that never saw the removal, still holding the old value.
    let remote = settings_payload(
        json!({"general": {"theme": "dark"}}),
        json!({"general.theme": {"device-a": 1}}),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &remote, "64").await;

    assert_eq!(report.skipped, 1);
    assert_eq!(report.applied, 0);
    assert_eq!(report.corrupt, 0);
    assert_eq!(report.cursor.as_deref(), Some("64"));

    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(
        parsed["settings"]["general"].get("theme"),
        None,
        "the cleared preference must not come back on the next pull"
    );
    assert_eq!(
        parsed["fieldClocks"]["general.theme"],
        json!({"device-a": 2}),
        "the removal's tick is what beat the stale value"
    );
    assert!(projected_settings(&db).is_empty());
    assert_eq!(outbox_rows(&db, SETTINGS_ID), queued_before);

    // And the other seat: this device still holds the value, and the peer's
    // ticked removal arrives. #2399, protocol 06 §6.9.0 as amended by #2383:
    // an absent winner keeps the local value until desktop keeps unmodelled
    // keys (#2183), because a desktop echo of a stripped value looks the same.
    let peer = scratch_db("pull-settings-removal-peer");
    peer.call_blocking(|conn| {
        settings::set(conn, "general.theme", json!("dark"), "device-a", MERGE_NOW)?;
        Ok(())
    })
    .expect("the stale local value");
    let queued_before = outbox_rows(&peer, SETTINGS_ID);

    let removal = settings_payload(
        json!({"general": {}}),
        json!({"general.theme": {"device-a": 1, "device-b": 1}}),
    );
    let report = pull_one(&peer, SETTINGS_ID, "settings", &removal, "65").await;

    assert_eq!(report.applied, 1);
    assert_eq!(report.corrupt, 0);
    let parsed = stored_payload(&peer, "settings", SETTINGS_ID);
    assert_eq!(
        parsed["settings"]["general"]["theme"],
        json!("dark"),
        "removal is deferred: the local value stays"
    );
    assert_eq!(
        parsed["fieldClocks"]["general.theme"],
        json!({"device-a": 1, "device-b": 1}),
        "the removal's tick is kept, so the clock is ahead when removal ships"
    );
    assert_eq!(outbox_rows(&peer, SETTINGS_ID), queued_before);
}

/// #2399's repro: iOS writes a setting desktop does not model, desktop strips
/// the value, keeps the clock and echoes it on its next push. iOS keeps its
/// own setting.
#[tokio::test]
async fn a_desktop_echo_of_a_stripped_setting_keeps_the_ios_value() {
    let db = scratch_db("pull-settings-echo");
    db.call_blocking(|conn| {
        settings::set(
            conn,
            "experimental.agentSidebar",
            json!(true),
            "ios",
            MERGE_NOW,
        )?;
        Ok(())
    })
    .expect("the iOS setting");

    // Desktop edited the theme and pushed the echoed clock with no value.
    let echo = settings_payload(
        json!({"general": {"theme": "dark"}}),
        json!({
            "experimental.agentSidebar": {"ios": 1},
            "general.theme": {"desktop": 1}
        }),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &echo, "66").await;

    assert_eq!(report.applied, 1);
    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(
        parsed["settings"]["experimental"]["agentSidebar"],
        json!(true),
        "the tie goes to the remote, which has no value: the local one stays"
    );
    assert_eq!(parsed["settings"]["general"]["theme"], json!("dark"));
}

/// #2399, protocol 06 §6.9.0: a merge in which a path compared `concurrent`
/// re-queues the merged settings, in the same transaction as the write, so
/// the union clock reaches the server (#2287). A dominated path does not.
#[tokio::test]
async fn a_concurrent_settings_merge_requeues_the_merged_payload() {
    let db = scratch_db("pull-settings-requeue");
    seed_local_theme(&db);
    // The local edits were pushed.
    db.call_blocking(|conn| {
        conn.execute("DELETE FROM outbox", [])
            .expect("clear the outbox");
        Ok(())
    })
    .expect("pushed");

    // {device-a: 2} against {device-b: 3}: concurrent, remote total wins.
    let remote = settings_payload(
        json!({"general": {"theme": "dark"}}),
        json!({"general.theme": {"device-b": 3}}),
    );
    let report = pull_one(&db, SETTINGS_ID, "settings", &remote, "67").await;

    assert_eq!(report.applied, 1);
    let parsed = stored_payload(&db, "settings", SETTINGS_ID);
    assert_eq!(parsed["settings"]["general"]["theme"], json!("dark"));
    assert_eq!(
        parsed["fieldClocks"]["general.theme"],
        json!({"device-a": 2, "device-b": 3})
    );
    assert_eq!(outbox_rows(&db, SETTINGS_ID), 1, "the merge re-queued");

    // A later payload that dominates is taken without a re-queue.
    db.call_blocking(|conn| {
        conn.execute("DELETE FROM outbox", [])
            .expect("clear the outbox");
        Ok(())
    })
    .expect("pushed");
    let newer = settings_payload(
        json!({"general": {"theme": "light"}}),
        json!({"general.theme": {"device-a": 2, "device-b": 4}}),
    );
    pull_one(&db, SETTINGS_ID, "settings", &newer, "68").await;
    assert_eq!(
        stored_payload(&db, "settings", SETTINGS_ID)["settings"]["general"]["theme"],
        json!("light")
    );
    assert_eq!(outbox_rows(&db, SETTINGS_ID), 0);
}
