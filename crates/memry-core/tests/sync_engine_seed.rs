//! Where a pass seeds (#4025): after a pull that reached the feed head and before the push, as
//! Electron's full sync runs pull, seed, push. The seed is what makes the desktop's learned
//! property types definitions; a definition another device pushed first must land before it.
//!
//! | Test                                         | Rule                                         |
//! | -------------------------------------------- | -------------------------------------------- |
//! | the seed runs between the pull and the push  | it sees what the pull applied                |
//! | no seed after a failed or refused pull       | an unseen remote definition is not overrun   |
//! | no seed while the pull has more pages        | the same, at the page ceiling                |
//! | no seed while the outbox is parked           | nothing seeded to sit while a peer pushes    |
//! | a failed seed still pushes                   | the queue is not held by the seed            |

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::{ApiError, StorageError, TransportError};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::{MAX_PAGES_PER_PASS, PassSeed, PushWave, SyncEngine};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::state::PassTrigger;
use serde_json::json;

type Log = Arc<Mutex<Vec<String>>>;

fn scratch_db() -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-sync-seed-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct Plain;

impl RecordCipher for Plain {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(br#"{"name":"mood","type":"select"}"#.to_vec())
    }
}

struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// Notes in the log that it ran, and whether the pulled definition was there by then.
struct Seed {
    log: Log,
    db: Db,
    fails: bool,
}

#[async_trait::async_trait]
impl PassSeed for Seed {
    async fn seed(&self) -> Result<(), StorageError> {
        let pulled = self
            .db
            .call_blocking(|conn| sync_items::load(conn, "property_definition", "mood"))?
            .is_some();
        self.log
            .lock()
            .unwrap()
            .push(format!("seed pulled={pulled}"));
        if self.fails {
            return Err(StorageError::Failed {
                what: "the seed broke".into(),
            });
        }
        Ok(())
    }
}

struct Push {
    log: Log,
}

#[async_trait::async_trait]
impl PushWave for Push {
    async fn pending(&self) -> Result<usize, ApiError> {
        Ok(1)
    }

    async fn drain(&self) -> Result<(), ApiError> {
        self.log.lock().unwrap().push("push".into());
        Ok(())
    }
}

fn policy(writes: bool) -> String {
    json!({"clientPolicy": {"writesEnabled": writes}}).to_string()
}

fn changes(has_more: bool, items: &[&str]) -> String {
    let items: Vec<_> = items
        .iter()
        .map(|id| json!({"id": id, "type": "property_definition"}))
        .collect();
    json!({"items": items, "deleted": [], "hasMore": has_more, "nextCursor": "4"}).to_string()
}

fn mood_envelope() -> String {
    json!({"items": [{
        "id": "mood", "type": "property_definition", "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
    }]})
    .to_string()
}

/// One pass over `script`, with a seed that fails when `fails`; the log it leaves.
async fn pass(script: Vec<Result<HttpResponse, TransportError>>, fails: bool) -> Vec<String> {
    let db = scratch_db();
    let log: Log = Arc::default();
    let http = Arc::new(HttpClient::new(
        FakeTransport::new(script),
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("an identity"),
    ));
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Plain),
    ));
    let engine = SyncEngine::new(pull, http, Arc::new(Online))
        .with_push(Arc::new(Push { log: log.clone() }))
        .with_seed(Arc::new(Seed {
            log: log.clone(),
            db,
            fails,
        }));
    engine.run_pass(PassTrigger::Explicit).await;
    log.lock().unwrap().clone()
}

#[tokio::test]
async fn the_seed_runs_after_the_pull_landed_and_before_the_push() {
    let log = pass(
        vec![
            response(200, &policy(true)),
            response(200, &changes(false, &["mood"])),
            response(200, &mood_envelope()),
        ],
        false,
    )
    .await;
    assert_eq!(log, ["seed pulled=true", "push"]);
}

#[tokio::test]
async fn a_failed_or_refused_pull_seeds_nothing() {
    let failed = pass(
        vec![
            response(200, &policy(true)),
            response(400, r#"{"error":{"code":"SYNC_INVALID_CURSOR"}}"#),
        ],
        false,
    )
    .await;
    assert!(failed.is_empty(), "{failed:?}");

    // §5.14: a pull body that is not an envelope refuses the run.
    let refused = pass(
        vec![
            response(200, &policy(true)),
            response(200, &changes(false, &["mood"])),
            response(200, "[]"),
        ],
        false,
    )
    .await;
    assert!(refused.is_empty(), "{refused:?}");
}

#[tokio::test]
async fn a_pull_stopped_at_the_page_ceiling_seeds_nothing_and_still_pushes() {
    let mut script = vec![response(200, &policy(true))];
    for _ in 0..MAX_PAGES_PER_PASS {
        script.push(response(200, &changes(true, &[])));
    }
    let log = pass(script, false).await;
    assert_eq!(log, ["push"]);
}

#[tokio::test]
async fn a_parked_outbox_seeds_nothing() {
    let log = pass(
        vec![
            response(200, &policy(false)),
            response(200, &changes(false, &[])),
        ],
        false,
    )
    .await;
    assert!(log.is_empty(), "{log:?}");
}

#[tokio::test]
async fn a_failed_seed_still_pushes() {
    let log = pass(
        vec![
            response(200, &policy(true)),
            response(200, &changes(false, &[])),
        ],
        true,
    )
    .await;
    assert_eq!(log, ["seed pulled=false", "push"]);
}
