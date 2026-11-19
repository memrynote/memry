//! The Readwise scheduler and the vault's run service (`readwise::scheduler`, Electron's
//! `runtime-effects.ts`) on a real vault, the local Readwise stand-in and the one-row sync fake
//! of `readwise_run_gate.rs`.
//!
//! | Test                                                         | Electron                          |
//! | ------------------------------------------------------------ | --------------------------------- |
//! | a scheduled tick imports, and waits for the cadence after    | `runtime-effects.test.ts` (tick, cadence) |
//! | the claim held elsewhere: no run, the token is dropped       | `runtime-effects.ts:113`, `release.ts` |
//! | a restart takes one launch run that writes nothing new       | `lastAttemptAt` null at launch    |
//! | a vault close or a sign-out cancel stops the run and the tick | `stop()`, `cancel()`             |

use std::sync::atomic::AtomicI64;

use memry_desktop::readwise::claim::write_claim;
use memry_desktop::readwise::pull_gate::PullGate;
use memry_desktop::readwise::run_state::RunState;
use memry_desktop::readwise::run_types::RunGate;
use memry_desktop::readwise::scheduler::{ReadwiseRuns, RunsParts, SyncNowError};
use memry_desktop::readwise::token::ReadwiseToken;
use memry_desktop::seams::secure_store::GenericSecrets;

use super::claim::{Keychain, vault_files};
use super::gate::{Cloud, FakeSync, fake_sync, keychain_with_token, settings, two_books};
use super::*;

const HOUR_MS: i64 = 60 * 60 * 1000;
const T0: i64 = 1_800_000_000_000;

struct Rig {
    v: Vault,
    keychain: Arc<Keychain>,
    sync: Arc<FakeSync>,
    clock: Arc<AtomicI64>,
    /// `readwise_sync_completed` results, in order.
    runs: Arc<Mutex<Vec<String>>>,
}

fn rig(id: &str, indexing: Box<dyn Fn() -> bool + Send + Sync>) -> Rig {
    let cloud = Cloud::default();
    let v = vault(&[], two_books());
    let keychain = keychain_with_token(&v);
    let sync = fake_sync(&v, id, "Desk Mac", &cloud, indexing);
    Rig {
        v,
        keychain,
        sync,
        clock: Arc::new(AtomicI64::new(T0)),
        runs: Arc::default(),
    }
}

impl Rig {
    /// One service, as one launch builds it for the open vault.
    fn service(&self) -> Arc<ReadwiseRuns> {
        let l = &self.v.library;
        let library = Library::new(
            l.open.clone(),
            Arc::clone(&l.notes),
            Arc::clone(&l.editor),
            Arc::clone(&l.images),
            Arc::clone(&l.indexing),
            l.runtime.clone(),
            Arc::clone(&l.activity),
        );
        let token = || {
            let secrets: Arc<dyn GenericSecrets> = self.keychain.clone();
            ReadwiseToken::new(secrets, &self.v.e.vault, None).unwrap()
        };
        let gate = Arc::new(
            PullGate::new(l.store(), settings(&self.v), token(), self.sync.clone())
                .with_poll(Duration::from_millis(1)),
        );
        let clock = Arc::clone(&self.clock);
        let clock = Arc::new(move || clock.load(Ordering::SeqCst));
        let engine = Engine::new(
            self.v._server.client(),
            Arc::clone(&gate) as Arc<dyn RunGate>,
            clock.clone(),
            Arc::new(|| Ok(chrono_tz::UTC)),
        )
        .with_reader_limiter(Arc::new(RequestLimiter::new(1000, Duration::from_secs(1))));
        let runs = Arc::clone(&self.runs);
        Arc::new(ReadwiseRuns::new(RunsParts {
            library,
            engine,
            gate,
            token: token(),
            sync: self.sync.clone(),
            online: Arc::new(|| true),
            clock,
            track: Arc::new(move |event| {
                runs.lock().unwrap().push(event.result.unwrap_or_default());
            }),
        }))
    }

    fn runs(&self) -> Vec<String> {
        self.runs.lock().unwrap().clone()
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn has_token(&self) -> bool {
        let secrets: Arc<dyn GenericSecrets> = self.keychain.clone();
        let token = ReadwiseToken::new(secrets, &self.v.e.vault, None).unwrap();
        token.read().unwrap().is_some()
    }

    fn files(&self) -> usize {
        vault_files(&self.v)
    }
}

#[test]
fn a_scheduled_tick_imports_and_then_waits_for_the_cadence() {
    let r = rig("dev-a", Box::new(|| false));
    let runs = r.service();
    runs.tick();
    assert!(r.runs().is_empty(), "never before the first import");

    runs.sync_now().expect("the first import");
    assert_eq!(r.files(), 2);
    r.v.books.lock().unwrap().push(book(
        3,
        vec![highlight(31, "Third idea", "2026-10-22T18:07:00.000Z")],
    ));
    r.advance(HOUR_MS - 60_000);
    runs.tick();
    assert_eq!(r.runs().len(), 1, "an hourly cadence waits for its hour");
    assert_eq!(runs.next_run_at(), Some(T0 + HOUR_MS));

    r.advance(60_000);
    runs.tick();
    assert_eq!(r.runs(), ["success", "success"]);
    assert_eq!(r.files(), 3, "the scheduled run imported the new book");
}

#[test]
fn a_device_that_sees_the_claim_held_elsewhere_never_runs_and_drops_its_token() {
    let r = rig("dev-b", Box::new(|| false));
    r.v.state().set_cursor("2026-10-22T00:00:00.000Z").unwrap();
    write_claim(&settings(&r.v), "dev-a", Some("Desk Mac")).unwrap();
    let runs = r.service();
    assert!(!runs.can_pull());
    assert!(matches!(runs.sync_now(), Err(SyncNowError::OtherDevice)));
    runs.tick();
    assert!(r.runs().is_empty(), "no run started");
    assert_eq!(r.files(), 0);
    assert!(!r.has_token(), "the idle tick dropped the token");
    assert_eq!(r.v.state().cursor().unwrap(), None, "and the run state");
    assert!(matches!(runs.sync_now(), Err(SyncNowError::NotConnected)));
}

#[test]
fn a_restart_takes_one_launch_run_that_writes_nothing_new() {
    let r = rig("dev-a", Box::new(|| false));
    let first = r.service();
    first.sync_now().expect("the first import");
    first.stop();
    let state = RunState::new(r.v.library.store());
    let cursor = state.cursor().unwrap();

    let relaunched = r.service();
    relaunched.tick();
    relaunched.tick();
    assert_eq!(
        r.runs(),
        ["success", "success"],
        "one launch run, then the cadence"
    );
    assert_eq!(
        r.files(),
        2,
        "the launch run found the notes it wrote before"
    );
    let last = state.last_run().unwrap().unwrap().counts.unwrap();
    assert_eq!(changed(&last), 0, "{last:?}");
    assert_eq!(state.cursor().unwrap(), cursor);
}

#[test]
fn a_vault_close_or_a_sign_out_cancel_stops_the_run_and_the_tick() {
    let indexing = Arc::new(AtomicBool::new(true));
    let held = Arc::clone(&indexing);
    let r = rig("dev-a", Box::new(move || held.load(Ordering::SeqCst)));
    r.v.state().set_cursor("2026-10-22T00:00:00.000Z").unwrap();

    // Sign-out: the run in flight stops, and the tick goes on.
    let runs = r.service().with_tick_for_test();
    runs.start();
    wait_until(|| runs.is_running());
    runs.cancel();
    wait_until(|| r.runs().len() == 1);
    assert_eq!(r.runs(), ["canceled"]);

    // Vault close: the run waiting on the index stops, the tick ends, and nothing runs again.
    r.advance(HOUR_MS);
    wait_until(|| runs.is_running());
    runs.stop();
    assert!(!runs.is_running());
    assert_eq!(r.runs(), ["canceled", "canceled"]);
    indexing.store(false, Ordering::SeqCst);
    r.advance(HOUR_MS);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(r.runs().len(), 2, "no tick after the close");
    assert_eq!(r.files(), 0, "nothing was written");
    assert!(r.has_token(), "a cancel keeps the connection");
}

trait FastTick {
    fn with_tick_for_test(self) -> Arc<ReadwiseRuns>;
}

impl FastTick for Arc<ReadwiseRuns> {
    fn with_tick_for_test(self) -> Arc<ReadwiseRuns> {
        let runs = Arc::into_inner(self).expect("one handle");
        Arc::new(runs.with_tick(Duration::from_millis(5)))
    }
}

fn wait_until(done: impl Fn() -> bool) {
    for _ in 0..15_000 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("the condition never held");
}
