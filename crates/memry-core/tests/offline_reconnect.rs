//! Offline, then reconnect (T136, FR-030, data-model §C.3, chapter 11 §11.9).
//!
//! Real `SyncEngine`, real `PushCoordinator`, real `PullLoop`, real SQLite,
//! real outbox. The fakes are the three seams the core does not own: the
//! `Transport`, the record cipher, and `Reachability`. **Nothing here reaches a
//! network.**
//!
//! Two claims, and the second is the one that is easy to assert trivially:
//!
//! - **A queued wave drains completely** after the transition — every row, not
//!   the first batch, and across both routes, since §A.2 puts the CRDT rows
//!   ahead of the record rows and they go to different endpoints.
//! - **The drain runs on the transition, not on the next timer.** The only
//!   mechanism by which a queue *would* wait for a timer is backoff: a row with
//!   `next_attempt_at` in the future is invisible to the claim, so a pass that
//!   ran while offline and "tried anyway" would leave the whole wave parked for
//!   its retry ladder. §11.9 says a parked queue must drain at full speed the
//!   moment the condition clears. So the assertion that carries the claim is
//!   that the offline pass attempts nothing, defers nothing and costs nothing,
//!   and the contrast test below shows what a queue that *did* accrue backoff
//!   looks like — it does not drain on the next pass at all.
//!
//! **Gap, reported rather than asserted around.** `Reachability::observe` is
//! never called anywhere in `crates/`: the engine reads `current()` at the top
//! of each pass and nothing registers a `ReachabilityObserver`. So "on the
//! transition" is the shell's call into [`SyncEngine::run_pass`], and what the
//! core guarantees is that the call succeeds immediately and completely. The
//! seam's own doc comment claims more than the core currently wires.

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, RecordingSleeper, response};
use memry_core::api::errors::StorageError;
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::SyncEngine;
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use memry_core::sync::state::{PassTrigger, SyncState};
use serde_json::{Value as Json, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DOC_ID: &str = "abc123def456";

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-reconnect-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// The clock the engine and the push wave read. The outbox's `next_attempt_at`
/// is compared against this one, not against [`NOW`], so a test that wants a
/// row to be genuinely in backoff has to park it in the real future.
fn real_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A reachability the test flips, and which records whether the core ever
/// registered an observer on it.
struct SwitchableReachability {
    state: Mutex<Reachable>,
    observers: AtomicUsize,
}

impl SwitchableReachability {
    fn starting(state: Reachable) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(state),
            observers: AtomicUsize::new(0),
        })
    }

    fn transition_to(&self, next: Reachable) {
        *self.state.lock().unwrap() = next;
    }

    fn observers(&self) -> usize {
        self.observers.load(Ordering::Relaxed)
    }
}

impl Reachability for SwitchableReachability {
    fn current(&self) -> Reachable {
        *self.state.lock().unwrap()
    }

    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {
        self.observers.fetch_add(1, Ordering::Relaxed);
    }
}

struct NeverOpened;

impl RecordCipher for NeverOpened {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

struct PassthroughSealer;

impl PushSealer for PassthroughSealer {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        Ok(json!({
            "id": item.row.item_id,
            "type": item.row.item_type,
            "operation": item.operation.as_str(),
            "encryptedData": item.row.payload.clone().unwrap_or_default(),
        }))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// The whole engine, over one transport script and one reachability switch.
fn engine_for(
    db: &Db,
    transport: Arc<FakeTransport>,
    sleeper: Arc<RecordingSleeper>,
    reachability: Arc<SwitchableReachability>,
) -> SyncEngine {
    let http = Arc::new(
        HttpClient::new(
            transport,
            "https://sync.example",
            ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
        )
        .with_sleeper(sleeper),
    );
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NeverOpened),
    ));
    let push = Arc::new(PushCoordinator::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassthroughSealer),
    ));
    SyncEngine::new(pull, http, reachability).with_push(push)
}

fn new_note(id: &str) -> NewNote<'_> {
    NewNote {
        id,
        title: "A note",
        folder_path: Some("Notes"),
        content: "",
        tags: &[],
        properties: None,
    }
}

/// A wave queued while the device was away: three body updates for one
/// document and three record changes. Two batches, two routes (§A.2).
fn queue_a_wave(db: &Db) {
    db.call_blocking(|conn| {
        notes::create(conn, &new_note(DOC_ID), DEVICE, NOW)?;
        for suffix in ["two", "three"] {
            notes::create(conn, &new_note(&format!("note{suffix}")), DEVICE, NOW)?;
        }
        // The body edits. A Y.Doc apply is the real source of these bytes and
        // belongs to the CRDT tier's own tests; what matters here is that the
        // wave has rows on both routes, so "drains completely" means more than
        // one batch.
        for tick in 1u8..=3 {
            outbox::commit(
                conn,
                &Change::crdt_update(notes::ITEM_TYPE, DOC_ID, vec![tick; 8]),
                NOW + i64::from(tick),
                |_tx| Ok(()),
            )?;
        }
        Ok(())
    })
    .expect("queue the wave");
}

fn depth(db: &Db) -> usize {
    db.call_blocking(|conn| outbox::depth(conn))
        .expect("the queue depth")
}

fn claimable(db: &Db, at_ms: i64) -> usize {
    db.call_blocking(move |conn| outbox::pending(conn, at_ms))
        .expect("the claimable rows")
}

/// Every row's retry bookkeeping, which is what decides whether a queue drains
/// now or on some later timer.
fn backoff(db: &Db) -> Vec<(i64, Option<i64>)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT attempt_count, next_attempt_at FROM outbox ORDER BY id")
            .map_err(failed)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .map_err(failed)?;
        Ok(rows)
    })
    .expect("read the backoff columns")
}

fn paths(transport: &FakeTransport) -> Vec<String> {
    transport
        .calls()
        .into_iter()
        .map(|call| {
            call.url
                .trim_start_matches("https://sync.example")
                .to_owned()
        })
        .collect()
}

fn status_ok() -> String {
    json!({"clientPolicy": {"writesEnabled": true}, "serverTime": NOW}).to_string()
}

fn empty_page() -> String {
    json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": "1"}).to_string()
}

fn push_ok(accepted: &[&str]) -> String {
    json!({"accepted": accepted, "rejected": [], "serverTime": NOW, "maxCursor": 1}).to_string()
}

// -------------------------------------------------- the wave drains, whole

/// **A queued wave drains completely after a simulated reachability
/// transition** (T136).
///
/// The wave is deliberately two batches on two routes: §A.2 orders every CRDT
/// row ahead of every record row, and `next_batch` never mixes them, so a
/// drain that stopped after one `POST` would leave three rows behind and still
/// look like it pushed. "Completely" is asserted as a depth of zero, and the
/// call log is asserted as well so the test can tell a real drain from an
/// early exit that emptied the queue some other way.
#[tokio::test]
async fn a_queued_wave_drains_completely_after_the_reachability_transition() {
    let db = scratch_db("drain");
    queue_a_wave(&db);
    assert_eq!(depth(&db), 6, "three body updates and three record changes");

    let transport = FakeTransport::new(vec![
        response(200, &status_ok()),
        response(200, &empty_page()),
        response(200, &json!({"sequences": [1, 2, 3]}).to_string()),
        response(200, &push_ok(&[DOC_ID, "notetwo", "notethree"])),
    ]);
    let reachability = SwitchableReachability::starting(Reachable::Offline);
    let engine = engine_for(
        &db,
        transport.clone(),
        RecordingSleeper::new(),
        Arc::clone(&reachability),
    );

    // Away. §C.3: `Idle -> Offline`, and there is nothing to read from either.
    let away = engine.run_pass(PassTrigger::Timer).await;
    assert_eq!(away.final_state, SyncState::Offline);
    assert!(!away.pushed);
    assert_eq!(
        transport.call_count(),
        0,
        "an unreachable network is not a request that fails; it is a request not made"
    );
    assert_eq!(depth(&db), 6, "and no row was removed while away");

    // Back. The shell's reachability callback runs a pass; §C.3 draws one
    // entry edge into `Pulling` for every trigger.
    reachability.transition_to(Reachable::Wifi);
    let back = engine.run_pass(PassTrigger::SocketHint).await;

    assert_eq!(back.final_state, SyncState::Idle);
    assert!(back.pushed, "the wave went out on the transition pass");
    assert!(!back.parked);
    assert_eq!(
        depth(&db),
        0,
        "every queued row drained, not just the first batch"
    );
    assert_eq!(
        paths(&transport),
        vec![
            "/sync/status",
            "/sync/changes?limit=500",
            "/sync/crdt/updates",
            "/sync/push",
        ],
        "§A.2: the body updates go first, on their own route, then the records"
    );
    assert!(
        back.transitions.contains(&SyncState::Pushing),
        "the pass entered Pushing rather than reporting a push it never made: {:?}",
        back.transitions
    );

    // The seam is read, never subscribed to. Recorded so the day the core does
    // register an observer, this line is what tells the next reader the
    // guarantee changed.
    assert_eq!(
        reachability.observers(),
        0,
        "the core reads `current()` per pass and registers no observer"
    );
}

// ------------------------------ on the transition, not on the next timer

/// **The drain runs on the transition rather than waiting for the next
/// timer** (T136, §11.9).
///
/// The claim only means something against the mechanism that would make it
/// false, so this test names it. A row whose `next_attempt_at` is in the
/// future is invisible to `outbox::claim`, so a pass that had "tried anyway"
/// while offline would have deferred the whole wave onto the retry ladder and
/// the transition pass would push nothing at all. The second half of this test
/// is that failure, produced deliberately, so the first half cannot pass by
/// asserting something trivially true.
#[tokio::test]
async fn the_transition_pass_drains_at_once_because_the_offline_pass_accrued_no_backoff() {
    let db = scratch_db("no-backoff");
    queue_a_wave(&db);

    let transport = FakeTransport::new(vec![
        response(200, &status_ok()),
        response(200, &empty_page()),
        response(200, &json!({"sequences": [1, 2, 3]}).to_string()),
        response(200, &push_ok(&[DOC_ID, "notetwo", "notethree"])),
        // The last pass still pulls: reads are never gated (§11.4).
        response(200, &empty_page()),
    ]);
    let sleeper = RecordingSleeper::new();
    let reachability = SwitchableReachability::starting(Reachable::Offline);
    let engine = engine_for(
        &db,
        transport.clone(),
        Arc::clone(&sleeper),
        Arc::clone(&reachability),
    );

    // Three passes' worth of being away. None of them may cost the queue
    // anything, or the ladder is already climbing before the device is back.
    for _ in 0..3 {
        let away = engine.run_pass(PassTrigger::Timer).await;
        assert_eq!(away.final_state, SyncState::Offline);
    }
    assert_eq!(
        backoff(&db),
        vec![(0, None); 6],
        "§11.9: no attempt, no backoff, no row removed while the device is away"
    );

    // The instant the transition happens, the whole wave is claimable. This is
    // what "at full speed the moment the policy clears" reduces to.
    reachability.transition_to(Reachable::Wifi);
    let at_transition = real_now_ms();
    assert_eq!(
        claimable(&db, at_transition),
        6,
        "every row is claimable at the transition instant, with nothing parked behind a timer"
    );

    let back = engine.run_pass(PassTrigger::SocketHint).await;
    assert_eq!(back.trigger, PassTrigger::SocketHint);
    assert!(back.pushed);
    assert_eq!(depth(&db), 0);
    assert!(
        sleeper.slept().is_empty(),
        "the drain waited on nothing: {:?}",
        sleeper.slept()
    );

    // The contrast. One more change, deferred the way a rejected row is, and
    // the next pass pushes nothing: this is the "waits for the next timer"
    // behaviour, and the assertions above are what rule it out.
    db.call_blocking(|conn| {
        notes::create(conn, &new_note("notefour"), DEVICE, NOW)?;
        let ids: Vec<i64> = vec![
            conn.query_row("SELECT max(id) FROM outbox", [], |row| row.get(0))
                .map_err(failed)?,
        ];
        outbox::defer(conn, &ids, "rejected", Some(real_now_ms() + 600_000))
    })
    .expect("defer the new row");

    assert_eq!(depth(&db), 1);
    assert_eq!(
        claimable(&db, at_transition),
        0,
        "a backed-off row is invisible to the claim until its timer expires"
    );

    // No `/sync/push` is scripted, so a pass that tried to send it would panic
    // on an unscripted request rather than quietly pass.
    let parked = engine.run_pass(PassTrigger::SocketHint).await;
    assert!(
        !parked.pushed,
        "a queue in backoff is exactly the queue that waits for the next timer"
    );
    assert_eq!(depth(&db), 1);
}

/// Reachability is read **per pass**, not captured when the engine is built.
///
/// A device that went offline again between two passes must be seen to have
/// gone offline again; caching the answer is how an app keeps firing requests
/// into a dead radio and burning the battery it was meant to save.
#[tokio::test]
async fn reachability_is_read_on_every_pass_and_not_captured_at_construction() {
    let db = scratch_db("per-pass");
    let transport = FakeTransport::new(vec![
        response(200, &status_ok()),
        response(200, &empty_page()),
        // The third pass polls no policy — §11.8.1's interval has not elapsed
        // — but it still pulls.
        response(200, &empty_page()),
    ]);
    let reachability = SwitchableReachability::starting(Reachable::Wifi);
    let engine = engine_for(
        &db,
        transport.clone(),
        RecordingSleeper::new(),
        Arc::clone(&reachability),
    );

    let online = engine.run_pass(PassTrigger::Foreground).await;
    assert_eq!(online.final_state, SyncState::Idle);
    let after_online = transport.call_count();
    assert_eq!(after_online, 2);

    reachability.transition_to(Reachable::Offline);
    let offline = engine.run_pass(PassTrigger::Timer).await;
    assert_eq!(offline.final_state, SyncState::Offline);
    assert_eq!(
        transport.call_count(),
        after_online,
        "the second pass re-read the seam and made no request"
    );

    // And back again, from `Offline`, which §C.3 exits only to `Idle`.
    reachability.transition_to(Reachable::Cellular);
    let back = engine.run_pass(PassTrigger::SocketHint).await;
    assert_eq!(back.final_state, SyncState::Idle);
    assert_eq!(
        back.transitions.first(),
        Some(&SyncState::Idle),
        "§C.3: `Offline` draws exactly one exit and it is to `Idle`: {:?}",
        back.transitions
    );
}
