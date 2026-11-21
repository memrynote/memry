//! The claim (stage 33d3): one device pulls from Readwise, named in the synced `readwise`
//! group, and another takes over only when the user asks (`claim.ts`, `release.ts`, D8). Each
//! device is its own harness, a temp vault with its own data DB and keychain, as two installs
//! are; memry sync is a stand-in that writes the claim on both.
//!
//! | Test                                                                  | Electron                                   |
//! | --------------------------------------------------------------------- | ------------------------------------------ |
//! | the claim record: two leaves, cleared with `null`, other leaves kept  | `claim.test.ts`                            |
//! | two installs: one pulls; a dead holder is never taken over by itself  | `sync-service.takeover.test.ts:370`, `:434` |
//! | an idle device drops its token and run state once the claim moves      | `sync-service.takeover.test.ts:460`, `:477` |
//! | with sync off a stale claim never stops a run                          | `sync-service.takeover.test.ts:424`        |

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::AtomicI64;

use memry_core::api::errors::SecureStoreError;
use memry_core::api::settings::Settings;
use memry_desktop::readwise::claim::{Claim, clear_claim, write_claim};
use memry_desktop::readwise::release::ClaimGate;
use memry_desktop::readwise::token::{ReadwiseToken, TOKEN_SERVICE};
use memry_desktop::seams::secure_store::GenericSecrets;

use super::*;

const TOKEN: &str = "token";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One install's keychain.
#[derive(Default)]
struct Keychain(Mutex<HashMap<(String, String), Vec<u8>>>);

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        let key = (service.to_owned(), account.to_owned());
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        let key = (service.to_owned(), account.to_owned());
        self.0.lock().unwrap().insert(key, value.to_vec());
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        let key = (service.to_owned(), account.to_owned());
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
}

/// One install: its vault, its keychain, and an engine whose gate is the claim.
struct Device {
    v: Vault,
    keychain: Arc<Keychain>,
    gate: Arc<ClaimGate>,
    engine: Engine,
    clock: Arc<AtomicI64>,
}

fn device(id: Option<&'static str>, books: Vec<Value>) -> Device {
    let v = vault(&[], books);
    let keychain = Arc::new(Keychain::default());
    let secrets: Arc<dyn GenericSecrets> = keychain.clone();
    let token = ReadwiseToken::new(secrets, &v.e.vault, None).unwrap();
    let this_device = Arc::new(move || id.map(str::to_owned));
    let gate = Arc::new(ClaimGate::new(v.library.store(), token, this_device));
    let clock = Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis()));
    let device = Device {
        engine: engine(&v, &gate, &clock),
        v,
        keychain,
        gate,
        clock,
    };
    device.store_token();
    device
}

/// A fresh engine over the device's gate, as after a restart.
fn engine(v: &Vault, gate: &Arc<ClaimGate>, clock: &Arc<AtomicI64>) -> Engine {
    let now = Arc::clone(clock);
    Engine::new(
        v._server.client(),
        Arc::clone(gate) as Arc<dyn memry_desktop::readwise::run_types::RunGate>,
        Arc::new(move || now.load(Ordering::SeqCst)),
        Arc::new(|| Ok(chrono_tz::UTC)),
    )
    .with_reader_limiter(Arc::new(RequestLimiter::new(1000, Duration::from_secs(1))))
}

impl Device {
    fn settings(&self) -> Arc<Settings> {
        let open = &self.v.library.open;
        open.vault.settings(self.v.store.clone()).unwrap()
    }

    fn token(&self) -> ReadwiseToken {
        let secrets: Arc<dyn GenericSecrets> = self.keychain.clone();
        ReadwiseToken::new(secrets, &self.v.e.vault, None).unwrap()
    }

    /// The token pasted on this device (connect or takeover).
    fn store_token(&self) {
        let account = memry_desktop::readwise::token::token_account(&self.v.e.vault, None).unwrap();
        self.keychain
            .set_secret(TOKEN_SERVICE, &account, TOKEN.as_bytes())
            .unwrap();
    }

    fn has_token(&self) -> bool {
        self.token().read().unwrap().is_some()
    }

    fn run(&self) -> RunResult {
        self.engine
            .run(
                &self.v.library,
                TOKEN,
                &Unobserved,
                &CancellationToken::new(),
            )
            .expect("the run")
    }

    fn notes(&self) -> usize {
        self.v.library.store().links(None).unwrap().len()
    }

    fn indexed(&self) -> usize {
        let store = self.v.library.store();
        store.highlights_between("0000", "9999").unwrap().len()
    }
}

/// Memry sync delivered `id`'s claim to every device.
fn deliver(id: &str, name: &str, devices: &[&Device]) {
    for device in devices {
        write_claim(&device.settings(), id, Some(name)).unwrap();
    }
}

/// An observer whose process dies in the middle of the run.
struct Dies;
impl RunObserver for Dies {
    fn writing(&self, _title: &str) {
        panic!("the process died");
    }
}

#[test]
fn the_claim_is_two_leaves_cleared_with_null_and_other_leaves_stay() {
    let a = device(Some("dev-a"), Vec::new());
    let settings = a.settings();
    let store = a.v.library.store();

    clear_claim(&store, &settings).unwrap();
    assert_eq!(settings.get("readwise.syncDeviceId".into()).unwrap(), None);

    settings
        .set("readwise.cadence".into(), "\"daily\"".into())
        .unwrap();
    write_claim(&settings, "dev-a", None).unwrap();
    assert_eq!(
        Claim::read(&store).unwrap(),
        Claim {
            device_id: Some("dev-a".into()),
            device_name: None
        }
    );
    let group = store.settings_group().unwrap();
    assert_eq!(group["cadence"], json!("daily"));
    assert_eq!(group["syncDeviceName"], Value::Null);

    write_claim(&settings, "dev-a", Some("Desk Mac")).unwrap();
    assert_eq!(
        Claim::read(&store).unwrap().device_name.as_deref(),
        Some("Desk Mac")
    );

    clear_claim(&store, &settings).unwrap();
    for leaf in ["readwise.syncDeviceId", "readwise.syncDeviceName"] {
        assert_eq!(settings.get(leaf.into()).unwrap().as_deref(), Some("null"));
    }
    assert_eq!(Claim::read(&store).unwrap(), Claim::default());
    assert_eq!(store.settings_group().unwrap()["cadence"], json!("daily"));
}

#[test]
fn a_claim_reads_only_non_empty_strings() {
    let claim = Claim::from_group(&json!({ "syncDeviceId": "", "syncDeviceName": 7 }));
    assert_eq!(claim, Claim::default());
    let claim = Claim::from_group(&json!({ "syncDeviceId": "dev-b", "syncDeviceName": "Laptop" }));
    assert!(claim.held_elsewhere(Some("dev-a")));
    assert!(!claim.held_elsewhere(Some("dev-b")));
    // Sync off or not registered: no peer to race.
    assert!(!claim.held_elsewhere(None));
    assert!(!Claim::default().held_elsewhere(Some("dev-a")));
}

#[test]
fn two_installs_one_pulls_and_a_dead_holder_is_taken_over_only_when_asked() {
    let mut a = device(Some("dev-a"), two_highlights());
    let mut b = device(Some("dev-b"), two_highlights());
    deliver("dev-a", "Desk Mac", &[&a, &b]);

    // B is not the claimant: it stops before its first book and writes nothing.
    let run = b.run();
    assert!(run.claim_lost && run.cancelled, "{run:?}");
    assert_eq!((b.notes(), changed(&run.counts)), (0, 0));
    assert_eq!(b.v.state().cursor().unwrap(), None);
    assert!(
        !b.has_token(),
        "the device that does not pull drops its token"
    );

    // A holds the claim and pulls.
    let run = a.run();
    assert!(!run.claim_lost, "{run:?}");
    assert_eq!(a.notes(), 1);
    assert!(a.has_token());

    // A dies in the middle of a run. Its claim stays: nothing on B expires it.
    a.v.books.lock().unwrap()[0]["highlights"]
        .as_array_mut()
        .unwrap()
        .push(highlight(13, "new", "2026-10-24T09:00:00.000Z"));
    let died = catch_unwind(AssertUnwindSafe(|| {
        a.engine
            .run(&a.v.library, TOKEN, &Dies, &CancellationToken::new())
    }));
    assert!(died.is_err());
    b.store_token();
    for _ in 0..2 {
        b.clock.fetch_add(30 * DAY_MS, Ordering::SeqCst);
        let run = b.run();
        assert!(
            run.claim_lost,
            "a month later B still does not pull: {run:?}"
        );
        assert_eq!(b.notes(), 0);
    }

    // The user takes over on B: the claim moves, the token is pasted again, B pulls.
    deliver("dev-b", "Laptop", &[&b]);
    b.store_token();
    b.engine = engine(&b.v, &b.gate, &b.clock);
    let run = b.run();
    assert!(!run.claim_lost, "{run:?}");
    assert_eq!(b.notes(), 1);

    // A restarts after the claim reached it: it stops at its first book, keeps its note, and
    // drops its token and run state.
    a.engine = engine(&a.v, &a.gate, &a.clock);
    let restarted = a;
    deliver("dev-b", "Laptop", &[&restarted]);
    assert!(restarted.v.state().cursor().unwrap().is_some());
    let run = restarted.run();
    assert!(run.claim_lost, "{run:?}");
    assert_eq!(restarted.notes(), 1);
    assert!(!restarted.has_token());
    assert_eq!(restarted.v.state().cursor().unwrap(), None);
    assert_eq!(restarted.indexed(), 0);
}

#[test]
fn an_idle_device_drops_its_token_and_run_state_once_the_claim_moves() {
    let a = device(Some("dev-a"), two_highlights());
    deliver("dev-a", "Desk Mac", &[&a]);
    a.run();
    assert!(a.indexed() > 0);

    assert!(!a.gate.release_if_claimed_elsewhere().unwrap());
    assert!(a.has_token(), "the holder keeps its token");

    deliver("dev-b", "Laptop", &[&a]);
    assert!(a.gate.release_if_claimed_elsewhere().unwrap());
    assert!(!a.has_token());
    assert_eq!(a.v.state().cursor().unwrap(), None);
    assert_eq!(a.v.state().last_run().unwrap(), None);
    assert_eq!(a.indexed(), 0);
    assert_eq!(a.notes(), 1, "every note and its link stay");
    assert!(!a.gate.release_if_claimed_elsewhere().unwrap());
}

#[test]
fn with_sync_off_a_stale_claim_never_stops_a_run() {
    let a = device(None, two_highlights());
    deliver("dev-b", "Laptop", &[&a]);
    let run = a.run();
    assert!(!run.claim_lost, "{run:?}");
    assert_eq!(a.notes(), 1);
    assert!(!a.gate.release_if_claimed_elsewhere().unwrap());
    assert!(a.has_token());
}
