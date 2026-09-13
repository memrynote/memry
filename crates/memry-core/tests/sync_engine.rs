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
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::repositories::Change;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::{PassReport, PushWave, SyncEngine};
use memry_core::sync::pull::{PullLoop, RecordCipher};
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
        urls[2].ends_with("/sync/changes?limit=500&cursor=100"),
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
