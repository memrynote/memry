//! The pre-push hook's deferral policy, through a real `data.db` and the push wave
//! (`prepareCanvasItems`, `push-coordinator.ts:745-786`).
//!
//! | Test                                                              | Rule                        |
//! | ----------------------------------------------------------------- | --------------------------- |
//! | a hook that always defers waits four waves, pushes on the fifth   | `MAX_CANVAS_HOLD_DEFERRALS` |
//! | a push from the hook resets the count                             | `canvasHoldDeferrals.delete`|
//! | with no hook registered nothing waits                             | `if (!prepare) return`      |
//! | other types, deletes and the rest of the batch never wait         | `type !== 'canvas'`, delete |
//! | an edit while the hook runs is one deferral in that wave          | `rejectedThisCycle`         |

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde_json::{Value as Json, json};

use super::{HoldDecision, MAX_HOLD_DEFERRALS, PrePushHook};
use crate::api::errors::{StorageError, TransportError};
use crate::protocol::envelope::EnvelopeError;
use crate::protocol::http::{ClientIdentity, HttpClient};
use crate::protocol::types::Declaration;
use crate::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use crate::storage::{Db, open_data};
use crate::sync::outbox::{self, Change};
use crate::sync::push::{PendingRecord, PushCoordinator, PushSealer};

/// Accepts every item of every push and records the ids each push carried.
#[derive(Default)]
struct Server(Mutex<Vec<Vec<String>>>);

impl Server {
    fn pushes_of(&self, id: &str) -> usize {
        let pushes = self.0.lock().unwrap();
        pushes
            .iter()
            .filter(|ids| ids.iter().any(|i| i == id))
            .count()
    }
}

#[async_trait::async_trait]
impl Transport for Server {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        assert!(request.url.ends_with("/sync/push"), "{}", request.url);
        let body: Json = serde_json::from_slice(&request.body.unwrap_or_default()).unwrap();
        let ids: Vec<String> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_owned())
            .collect();
        self.0.lock().unwrap().push(ids.clone());
        let answer = json!({ "accepted": ids, "rejected": [], "serverTime": 1, "maxCursor": 1 });
        Ok(HttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: answer.to_string().into_bytes(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets here".to_owned(),
        })
    }
}

struct Plain;

impl PushSealer for Plain {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        Ok(json!({ "id": item.row.item_id, "type": item.row.item_type }))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// Answers from its script, then `Defer` for ever; counts its calls per item.
#[derive(Default)]
struct Hook {
    script: Mutex<VecDeque<HoldDecision>>,
    calls: Mutex<Vec<String>>,
}

impl Hook {
    fn scripted(decisions: &[HoldDecision]) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(decisions.iter().copied().collect()),
            calls: Mutex::default(),
        })
    }

    fn calls_for(&self, id: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| *c == id)
            .count()
    }
}

#[async_trait::async_trait]
impl PrePushHook for Hook {
    async fn before_push(&self, _item_type: &str, item_id: &str) -> HoldDecision {
        self.calls.lock().unwrap().push(item_id.to_owned());
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(HoldDecision::Defer)
    }
}

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-pre-push-hook-")
        .tempdir()
        .unwrap()
        .keep();
    open_data(&dir.join("data.db")).unwrap()
}

/// A live row and a queued `op` for it.
fn queue(db: &Db, item_type: &'static str, item_id: &'static str, op: &'static str) {
    db.call_blocking(move |c| {
        let failed = |e: rusqlite::Error| StorageError::Failed {
            what: e.to_string(),
        };
        c.execute(
            "INSERT OR IGNORE INTO sync_items
                (item_type, item_id, payload, payload_state, clock, updated_at)
             VALUES (?1, ?2, '{}', 'full', '{\"device-a\":1}', 1)",
            params![item_type, item_id],
        )
        .map_err(failed)?;
        c.execute(
            "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES (?1, ?2, ?3, 1)",
            params![item_type, item_id, op],
        )
        .map_err(failed)?;
        Ok(())
    })
    .unwrap();
}

/// `(attempt_count, next_attempt_at)` of every queued row of `item_id`.
fn queued(db: &Db, item_id: &'static str) -> Vec<(i64, Option<i64>)> {
    db.call_blocking(move |c| {
        let mut statement = c
            .prepare("SELECT attempt_count, next_attempt_at FROM outbox WHERE item_id = ?1")
            .unwrap();
        let rows = statement
            .query_map([item_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        Ok(rows)
    })
    .unwrap()
}

fn coordinator(db: &Db, server: &Arc<Server>) -> PushCoordinator {
    let http = HttpClient::new(
        server.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").unwrap(),
    );
    PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Plain),
    )
}

#[tokio::test]
async fn a_hook_that_always_defers_holds_the_item_four_waves_and_pushes_it_on_the_fifth() {
    let (db, server, hook) = (
        scratch_db(),
        Arc::new(Server::default()),
        Hook::scripted(&[]),
    );
    queue(&db, "canvas", "c1", "upsert");
    let push = coordinator(&db, &server).with_pre_push_hook("canvas", hook.clone());

    for wave in 1..MAX_HOLD_DEFERRALS {
        let report = push.drain_wave().await.unwrap();
        assert_eq!(server.pushes_of("c1"), 0, "wave {wave}: still waiting");
        assert_eq!(hook.calls_for("c1"), wave as usize, "one try per wave");
        assert_eq!((report.accepted, report.rejected), (0, 0));
        assert_eq!(
            queued(&db, "c1"),
            [(0, None)],
            "attempts untouched, no backoff"
        );
    }

    push.drain_wave().await.unwrap();
    assert_eq!(
        server.pushes_of("c1"),
        1,
        "the fifth deferral pushes without the hold"
    );
    assert!(queued(&db, "c1").is_empty());

    push.drain_wave().await.unwrap();
    assert_eq!(server.pushes_of("c1"), 1, "pushed once");
}

#[tokio::test]
async fn a_push_from_the_hook_resets_the_count() {
    let (db, server) = (scratch_db(), Arc::new(Server::default()));
    let defer = HoldDecision::Defer;
    let hook = Hook::scripted(&[defer, defer, defer, HoldDecision::Push]);
    queue(&db, "canvas", "c1", "upsert");
    let push = coordinator(&db, &server).with_pre_push_hook("canvas", hook.clone());

    for _ in 0..4 {
        push.drain_wave().await.unwrap();
    }
    assert_eq!(
        server.pushes_of("c1"),
        1,
        "the hold finished on the fourth try"
    );

    // A new edit starts from zero: four more deferrals do not reach the cap.
    queue(&db, "canvas", "c1", "upsert");
    for _ in 1..MAX_HOLD_DEFERRALS {
        push.drain_wave().await.unwrap();
    }
    assert_eq!(
        server.pushes_of("c1"),
        1,
        "the count restarted after the push"
    );
    push.drain_wave().await.unwrap();
    assert_eq!(server.pushes_of("c1"), 2);
}

#[tokio::test]
async fn with_no_hook_registered_nothing_waits() {
    let (db, server) = (scratch_db(), Arc::new(Server::default()));
    queue(&db, "canvas", "c1", "upsert");
    queue(&db, "note", "n1", "upsert");

    coordinator(&db, &server).drain_wave().await.unwrap();

    assert_eq!(server.pushes_of("c1"), 1);
    assert_eq!(server.pushes_of("n1"), 1);
}

#[tokio::test]
async fn other_types_deletes_and_the_rest_of_the_batch_never_wait() {
    let (db, server, hook) = (
        scratch_db(),
        Arc::new(Server::default()),
        Hook::scripted(&[]),
    );
    queue(&db, "canvas", "c1", "upsert");
    queue(&db, "canvas", "c2", "delete");
    queue(&db, "note", "n1", "upsert");
    let push = coordinator(&db, &server).with_pre_push_hook("canvas", hook.clone());

    push.drain_wave().await.unwrap();

    assert_eq!(server.pushes_of("c1"), 0, "the canvas waits");
    assert_eq!(server.pushes_of("c2"), 1, "a delete never waits");
    assert_eq!(
        server.pushes_of("n1"),
        1,
        "a note in the same batch goes out"
    );
    assert_eq!(hook.calls_for("c2"), 0, "the hook never sees a delete");
    assert_eq!(hook.calls_for("n1"), 0, "nor another type");
}

/// Defers, and edits the item while the hold is in flight: the edit replaces the queued row
/// with one under a new outbox id.
struct EditingHook {
    db: Db,
    calls: Mutex<usize>,
}

#[async_trait::async_trait]
impl PrePushHook for EditingHook {
    async fn before_push(&self, item_type: &str, item_id: &str) -> HoldDecision {
        *self.calls.lock().unwrap() += 1;
        let change = Change::upsert(item_type, item_id);
        self.db
            .call(move |c| {
                let tx = c.unchecked_transaction().unwrap();
                outbox::enqueue(&tx, &change, 2)?;
                tx.commit().unwrap();
                Ok(())
            })
            .await
            .unwrap();
        HoldDecision::Defer
    }
}

#[tokio::test]
async fn an_edit_while_the_hook_runs_is_one_deferral_in_that_wave() {
    let (db, server) = (scratch_db(), Arc::new(Server::default()));
    queue(&db, "canvas", "c1", "upsert");
    let hook = Arc::new(EditingHook {
        db: db.clone(),
        calls: Mutex::default(),
    });
    let push = coordinator(&db, &server).with_pre_push_hook("canvas", hook.clone());

    for wave in 1..MAX_HOLD_DEFERRALS {
        push.drain_wave().await.unwrap();
        assert_eq!(
            *hook.calls.lock().unwrap(),
            wave as usize,
            "one try per wave"
        );
        assert_eq!(server.pushes_of("c1"), 0, "wave {wave}: still waiting");
    }
    push.drain_wave().await.unwrap();
    assert_eq!(
        server.pushes_of("c1"),
        1,
        "the fifth wave's deferral pushes, not an earlier one"
    );
}
