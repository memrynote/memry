//! The pull gate (stage 33d4, `pull-gate.ts`, D8). Each device is a temp vault with its own
//! data DB and keychain. Memry sync is a stand-in over the real pieces: a push sends the
//! device's queued `settings` payload to one server row that takes every push (§5.7), and a
//! pull applies that row through the real settings merge (`apply_inbound`, §6.9). A pass the
//! gate requests runs as a real one does: pull, then push, and the pull counter goes up when the
//! pass ends (`run_loop_pass.rs:151`, `engine.rs:319`).
//!
//! | Test                                                                    | Electron                       |
//! | ----------------------------------------------------------------------- | ------------------------------ |
//! | two offline claims in three sync orders: one runner, the loser writes no file | `pull-gate.ts:50-62`, departure |
//! | a claim delivered inside a pass is confirmed only by the next pass's pull | departure                      |
//! | residual: a peer that pushes after the confirming pull runs too           | same race, wider window        |
//! | a confirmed holder runs while its sync server is unreachable             | `pull-gate.ts:157-159`         |
//! | a first run claims Readwise and delivers the claim before it pulls       | `pull-gate.ts:122-133`         |
//! | the run waits for the index build                                        | `sync-service.ts:687-690`      |
//! | no sync pull yet: the run is held back, then refused as not ready        | `pull-gate.ts:171-178`         |
//! | sync off: the run pulls without a claim                                  | `pull-gate.ts:52-53`           |

use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;

use memry_core::api::settings::Settings;
use memry_core::domain::settings::SETTINGS_ITEM_TYPE;
use memry_core::storage::Db;
use memry_core::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
use memry_core::storage::repositories::sync_items::{InboundRecord, push_payload};
use memry_core::sync::apply::apply_inbound;
use memry_core::sync::outbox::queued_for;
use memry_desktop::readwise::claim::{Claim, write_claim};
use memry_desktop::readwise::pull_gate::{PullEnv, PullGate, PullGateError, SyncView};
use memry_desktop::readwise::run_types::{BookEvent, RunError, RunGate, RunObserver};
use memry_desktop::readwise::token::ReadwiseToken;
use memry_desktop::seams::secure_store::GenericSecrets;

use super::claim::{Keychain, TOKEN, vault_files};
use super::*;

/// The sync server's one `settings` row and its version: the last push stands.
type Cloud = Arc<Mutex<Option<(u64, String)>>>;

/// A step of a sync pass. `Wrap` is the rest of the pass after the push (other item types,
/// the cursor), so the pass ends some time after its push lands.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PassStep {
    Pull,
    Push,
    Wrap,
    End,
}

/// One device's memry sync.
struct FakeSync {
    db: Db,
    cloud: Cloud,
    env: Mutex<PullEnv>,
    pulled_version: AtomicU64,
    /// Passes that pulled and ended.
    pulls: AtomicU64,
    /// The running pass. It runs beside the gate: one step per gate query.
    pass: Mutex<VecDeque<PassStep>>,
    /// A pass was requested; it starts once the running one ends.
    requested: AtomicBool,
    after_push: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// The sync server is unreachable: no pass runs.
    offline: AtomicBool,
    indexing: Box<dyn Fn() -> bool + Send + Sync>,
    name: &'static str,
}

impl FakeSync {
    fn step(&self) {
        if self.offline.load(Ordering::SeqCst) {
            return;
        }
        let step = {
            let mut pass = self.pass.lock().unwrap();
            if pass.is_empty() && self.requested.swap(false, Ordering::SeqCst) {
                pass.extend([
                    PassStep::Pull,
                    PassStep::Push,
                    PassStep::Wrap,
                    PassStep::End,
                ]);
                return;
            }
            pass.pop_front()
        };
        match step {
            Some(PassStep::Pull) => self.pull(),
            Some(PassStep::Push) => {
                self.push();
                let hook = self.after_push.lock().unwrap().take();
                if let Some(hook) = hook {
                    hook();
                }
            }
            Some(PassStep::End) => {
                self.pulls.fetch_add(1, Ordering::SeqCst);
            }
            Some(PassStep::Wrap) | None => {}
        }
    }

    fn push(&self) {
        let cloud = Arc::clone(&self.cloud);
        self.db
            .call_blocking(move |conn| {
                if queued_for(conn, SETTINGS_ITEM_ID)? == 0 {
                    return Ok(());
                }
                let payload = push_payload(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?.unwrap();
                conn.execute("DELETE FROM outbox WHERE item_id = ?1", [SETTINGS_ITEM_ID])
                    .unwrap();
                let mut row = cloud.lock().unwrap();
                let version = row.as_ref().map_or(1, |(version, _)| version + 1);
                *row = Some((version, payload));
                Ok(())
            })
            .unwrap();
    }

    fn pull(&self) {
        let row = self.cloud.lock().unwrap().clone();
        if let Some((version, payload)) = row
            && version > self.pulled_version.load(Ordering::SeqCst)
        {
            let record = InboundRecord {
                item_type: SETTINGS_ITEM_TYPE.to_owned(),
                item_id: SETTINGS_ITEM_ID.to_owned(),
                payload_json: payload,
                server_cursor: Some(version as i64),
                signer_device_id: None,
                updated_at: version as i64,
                deleted_at: None,
            };
            let now = chrono::Utc::now().timestamp_millis();
            self.db
                .call_blocking(move |conn| apply_inbound(conn, &record, now).map(drop))
                .unwrap();
            self.pulled_version.store(version, Ordering::SeqCst);
        }
    }
}

impl SyncView for FakeSync {
    fn env(&self) -> PullEnv {
        self.env.lock().unwrap().clone()
    }
    fn caught_up(&self) -> bool {
        true
    }
    /// Requests a pass unless one that has not pulled yet is pending.
    fn request_push(&self) {
        if !self.pass.lock().unwrap().contains(&PassStep::Pull) {
            self.requested.store(true, Ordering::SeqCst);
        }
    }
    fn settings_queued(&self) -> bool {
        let queued = self
            .db
            .read_blocking(|conn| queued_for(conn, SETTINGS_ITEM_ID));
        self.step();
        queued.unwrap() > 0
    }
    fn completed_pulls(&self) -> u64 {
        let pulls = self.pulls.load(Ordering::SeqCst);
        self.step();
        pulls
    }
    fn device_name(&self) -> Option<String> {
        Some(self.name.to_owned())
    }
    fn indexing(&self) -> bool {
        (self.indexing)()
    }
}

/// One install whose engine runs behind the pull gate.
struct Device {
    v: Vault,
    keychain: Arc<Keychain>,
    sync: Arc<FakeSync>,
    engine: Engine,
}

fn device(id: &str, name: &'static str, cloud: &Cloud) -> Device {
    device_with(id, name, cloud, two_highlights(), Box::new(|| false))
}

fn device_with(
    id: &str,
    name: &'static str,
    cloud: &Cloud,
    books: Vec<Value>,
    indexing: Box<dyn Fn() -> bool + Send + Sync>,
) -> Device {
    let v = vault(&[], books);
    let keychain = Arc::new(Keychain::default());
    let secrets: Arc<dyn GenericSecrets> = keychain.clone();
    let token = ReadwiseToken::new(secrets, &v.e.vault, None).unwrap();
    let account = memry_desktop::readwise::token::token_account(&v.e.vault, None).unwrap();
    keychain
        .set_secret(
            memry_desktop::readwise::token::TOKEN_SERVICE,
            &account,
            b"token",
        )
        .unwrap();
    let sync = Arc::new(FakeSync {
        db: v.library.open.vault.db_handle(),
        cloud: Arc::clone(cloud),
        env: Mutex::new(PullEnv {
            decided: true,
            eligible: true,
            pulled: true,
            device_id: Some(id.to_owned()),
        }),
        pulled_version: AtomicU64::new(0),
        pulls: AtomicU64::new(0),
        pass: Mutex::default(),
        requested: AtomicBool::new(false),
        after_push: Mutex::default(),
        offline: AtomicBool::new(false),
        indexing,
        name,
    });
    let settings = settings(&v);
    let gate = PullGate::new(v.library.store(), settings, token, sync.clone())
        .with_poll(Duration::from_millis(1));
    let engine = Engine::new(
        v._server.client(),
        Arc::new(gate) as Arc<dyn RunGate>,
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
        Arc::new(|| Ok(chrono_tz::UTC)),
    )
    .with_reader_limiter(Arc::new(RequestLimiter::new(1000, Duration::from_secs(1))));
    Device {
        v,
        keychain,
        sync,
        engine,
    }
}

fn settings(v: &Vault) -> Arc<Settings> {
    v.library.open.vault.settings(v.store.clone()).unwrap()
}

impl Device {
    fn run(&self) -> Result<RunResult, RunError> {
        self.run_with(&CancellationToken::new())
    }

    fn run_with(&self, cancel: &CancellationToken) -> Result<RunResult, RunError> {
        self.engine.run(&self.v.library, TOKEN, &Unobserved, cancel)
    }

    fn run_observed(&self, observer: &dyn RunObserver) -> Result<RunResult, RunError> {
        let cancel = CancellationToken::new();
        self.engine.run(&self.v.library, TOKEN, observer, &cancel)
    }

    fn claim(&self) -> Claim {
        Claim::read(&self.v.library.store()).unwrap()
    }

    fn claim_offline(&self) {
        let env = self.sync.env();
        let id = env.device_id.unwrap();
        write_claim(&settings(&self.v), &id, Some(self.sync.name)).unwrap();
    }

    fn files(&self) -> usize {
        vault_files(&self.v)
    }

    fn has_token(&self) -> bool {
        let secrets: Arc<dyn GenericSecrets> = self.keychain.clone();
        let token = ReadwiseToken::new(secrets, &self.v.e.vault, None).unwrap();
        token.read().unwrap().is_some()
    }
}

#[derive(Clone, Copy, Debug)]
enum Step {
    Pull(usize),
    Push(usize),
}

/// Runs its closure once, when the run's first book is done.
struct AfterFirstBook(Mutex<Option<Box<dyn FnOnce() + Send>>>);

impl RunObserver for AfterFirstBook {
    fn book(&self, _event: &BookEvent) {
        let hook = self.0.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
}

fn two_books() -> Vec<Value> {
    vec![
        book(
            1,
            vec![highlight(11, "First idea", "2026-10-22T18:05:00.000Z")],
        ),
        book(
            2,
            vec![highlight(21, "Other idea", "2026-10-22T18:06:00.000Z")],
        ),
    ]
}

#[test]
fn two_offline_claims_in_three_sync_orders_end_with_one_runner() {
    use Step::{Pull, Push};
    // How sync interleaves the two devices once both are online, and the device whose claim
    // the server holds afterwards. The last order is a race Electron loses: each device holds
    // its own delivered claim until its next pull.
    let orders: [(&[Step], usize); 3] = [
        (&[Pull(0), Push(0), Pull(1), Push(1)], 0),
        (&[Pull(1), Push(1), Pull(0), Push(0)], 1),
        (&[Pull(0), Pull(1), Push(0), Push(1)], 1),
    ];
    for (order, winner) in orders {
        let cloud = Cloud::default();
        let devices = [
            device("dev-a", "Desk Mac", &cloud),
            device("dev-b", "Laptop", &cloud),
        ];
        for device in &devices {
            device.claim_offline();
        }
        for step in order {
            match *step {
                Pull(i) => devices[i].sync.pull(),
                Push(i) => devices[i].sync.push(),
            }
        }

        let runs = devices.each_ref().map(Device::run);
        let loser = 1 - winner;
        let won = runs[winner].as_ref().expect("the winner runs");
        assert!(!won.claim_lost && !won.cancelled, "{order:?}: {won:?}");
        assert!(devices[winner].files() > 0, "{order:?}");
        let names = ["Desk Mac", "Laptop"];
        match &runs[loser] {
            Err(RunError::Gate(PullGateError::Elsewhere(name))) => {
                assert_eq!(name.as_deref(), Some(names[winner]), "{order:?}");
            }
            other => panic!("{order:?}: the loser ran: {other:?}"),
        }
        assert_eq!(
            devices[loser].files(),
            0,
            "{order:?}: the loser wrote a file"
        );
        assert!(devices[loser].has_token(), "a refused run keeps its token");

        for device in devices.iter().chain(&devices) {
            device.sync.pull();
            device.sync.push();
        }
        let ids = ["dev-a", "dev-b"];
        for device in &devices {
            assert_eq!(device.claim().device_id.as_deref(), Some(ids[winner]));
        }
    }
}

#[test]
fn a_claim_delivered_inside_a_pass_is_confirmed_only_by_the_next_pass_pull() {
    let cloud = Cloud::default();
    let devices = [
        device("dev-a", "Desk Mac", &cloud),
        device("dev-b", "Laptop", &cloud),
    ];
    for device in &devices {
        device.claim_offline();
    }
    // A's pass pulls (no claim on the server yet), pushes A's claim, and B's claim lands right
    // after it, before A's pass ends. That pass's pull ran before the delivery.
    let b_sync = Arc::clone(&devices[1].sync);
    *devices[0].sync.after_push.lock().unwrap() = Some(Box::new(move || b_sync.push()));

    match devices[0].run() {
        Err(RunError::Gate(PullGateError::Elsewhere(name))) => {
            assert_eq!(name.as_deref(), Some("Laptop"));
        }
        other => panic!("A ran on the pull its own pass made before the delivery: {other:?}"),
    }
    assert_eq!(devices[0].files(), 0);
    devices[1].run().expect("B runs");
    assert!(devices[1].files() > 0);
}

/// The race the confirming pull does not close. Closing it needs a server-side compare-and-set.
#[test]
fn residual_a_peer_that_pushes_after_the_confirming_pull_runs_until_the_holder_pulls() {
    let cloud = Cloud::default();
    let no_index = || -> Box<dyn Fn() -> bool + Send + Sync> { Box::new(|| false) };
    let a = device_with("dev-a", "Desk Mac", &cloud, two_books(), no_index());
    let b = device_with("dev-b", "Laptop", &cloud, two_books(), no_index());
    a.claim_offline();
    b.claim_offline();
    // B pulls before A's claim reaches the server; A pushes and confirms.
    b.sync.pull();
    // B pushes after A's first book, and A's sync pulls B's claim.
    let (a_sync, b_sync) = (Arc::clone(&a.sync), Arc::clone(&b.sync));
    let observer = AfterFirstBook(Mutex::new(Some(Box::new(move || {
        b_sync.push();
        a_sync.pull();
    }))));

    let run = a.run_observed(&observer).expect("A runs");
    assert!(
        run.claim_lost,
        "A stops at its per-book claim check: {run:?}"
    );
    assert_eq!(a.files(), 1, "A wrote the book before its sync pulled");
    let run = b.run().expect("B runs too");
    assert!(!run.claim_lost, "{run:?}");
    assert_eq!(b.files(), 2);
    assert_eq!(a.claim().device_id.as_deref(), Some("dev-b"));
}

#[test]
fn a_confirmed_holder_runs_while_its_sync_server_is_unreachable() {
    let cloud = Cloud::default();
    let a = device("dev-a", "Desk Mac", &cloud);
    a.run().expect("the first run claims and confirms");
    // Sync delivered the run's settings while online. Anything still queued would hold the
    // run 30 s and refuse it as `claim-not-delivered`, as Electron does.
    a.sync.push();
    a.sync.offline.store(true, Ordering::SeqCst);
    // Electron waits only for an undelivered claim (`pull-gate.ts:157-159`).
    let run = a.run().expect("the holder runs without a sync pass");
    assert!(!run.claim_lost, "{run:?}");
}

#[test]
fn a_first_run_claims_readwise_and_delivers_the_claim_before_it_pulls() {
    let cloud = Cloud::default();
    let a = device("dev-a", "Desk Mac", &cloud);
    assert_eq!(a.claim(), Claim::default());

    let run = a.run().expect("the run");
    assert!(!run.claim_lost, "{run:?}");
    assert!(a.files() > 0);
    let claim = Claim {
        device_id: Some("dev-a".into()),
        device_name: Some("Desk Mac".into()),
    };
    assert_eq!(a.claim(), claim);
    let row = cloud
        .lock()
        .unwrap()
        .clone()
        .expect("the claim reached the server")
        .1;
    assert!(row.contains("\"syncDeviceId\":\"dev-a\""), "{row}");

    let b = device("dev-b", "Laptop", &cloud);
    b.sync.pull();
    assert_eq!(b.claim(), claim);
    assert!(matches!(
        b.run(),
        Err(RunError::Gate(PullGateError::Elsewhere(_)))
    ));
    assert_eq!(b.files(), 0);
}

#[test]
fn the_run_waits_for_the_index_build() {
    let cloud = Cloud::default();
    let cancel = CancellationToken::new();
    let polls = Arc::new(AtomicU64::new(0));
    let (stop, seen) = (cancel.clone(), Arc::clone(&polls));
    let a = device_with(
        "dev-a",
        "Desk Mac",
        &cloud,
        two_highlights(),
        Box::new(move || {
            if seen.fetch_add(1, Ordering::SeqCst) == 3 {
                stop.cancel();
            }
            true
        }),
    );
    let run = a.run_with(&cancel).expect("the run");
    assert!(run.cancelled, "{run:?}");
    assert!(polls.load(Ordering::SeqCst) > 3);
    assert_eq!(a.files(), 0, "nothing is written while the vault indexes");
    assert_eq!(a.v.state().cursor().unwrap(), None);
}

#[test]
fn without_a_sync_pull_the_run_is_held_back_then_refused_as_not_ready() {
    let cloud = Cloud::default();
    let a = device("dev-a", "Desk Mac", &cloud);
    a.sync.env.lock().unwrap().pulled = false;
    assert!(matches!(
        a.run(),
        Err(RunError::Gate(PullGateError::NotReady))
    ));
    assert_eq!(a.files(), 0);
    assert_eq!(a.claim(), Claim::default());
    assert!(a.has_token());
}

#[test]
fn with_sync_off_the_run_pulls_without_a_claim() {
    let cloud = Cloud::default();
    let a = device("dev-a", "Desk Mac", &cloud);
    a.sync.env.lock().unwrap().eligible = false;
    let run = a.run().expect("the run");
    assert!(!run.claim_lost, "{run:?}");
    assert!(a.files() > 0);
    assert_eq!(a.claim(), Claim::default());
}
