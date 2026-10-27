//! The keychain thread. Every OS keychain call of the app runs on one thread named
//! `memry-keyring`, never on a Tokio or Rayon thread, so a wedged D-Bus or Credential Manager
//! call cannot starve a runtime. Electron's keytar has no timeout either; its single-flight
//! queue with a 5 s deadline and an "unavailable" latch is what this ports
//! (`apps/desktop/src/main/secrets/secret-storage.ts`, `runKeytarOp`).
//!
//! A call waits at most [`DEADLINE`] for its answer. When the deadline passes, the latch is set:
//! every later call answers `Locked` at once, without queuing behind the stuck one. When the
//! stuck call finally returns, the latch lifts. The caller latches only while its job is not
//! done, and the worker marks a job done and lifts the latch under the same lock, so a call that
//! finishes at its deadline can never leave the latch set behind it. The recovery listeners fire
//! once when the keychain goes from unreachable (latched, or a call answered `Locked`) to
//! answering with a success, so a Secret Service that starts late is reported too; a panic or a
//! `Failed` answer is not a recovery. An unreadable secret is never reported absent: `NoEntry`
//! (after the store's own absent-check, see [`StoreFactory::absent_check`]) is the only `Ok(None)`.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use keyring_core::Error;
use memry_core::api::errors::SecureStoreError;
use zeroize::Zeroizing;

use super::keyring_backend::{Store, StoreFactory, entry};

/// How long a caller waits for the keychain (`KEYCHAIN_READ_TIMEOUT_MS`).
pub const DEADLINE: Duration = Duration::from_secs(5);
/// How long a caller that timed out at the instant its job finished waits for the answer.
const ANSWER_GRACE: Duration = Duration::from_secs(1);

pub type Secret = Zeroizing<Vec<u8>>;
/// `None` is an absent entry for a read, and the answer of a write or delete.
pub type Reply = Result<Option<Secret>, SecureStoreError>;
type Listener = Arc<dyn Fn() + Send + Sync>;

pub enum Op {
    Get,
    Set(Secret),
    Delete,
}

type Account = (String, String);

/// One caller waiting on a job, and whether it gave up.
struct Waiter {
    reply: Sender<Reply>,
    abandoned: Arc<AtomicBool>,
}

/// A queued job and the callers waiting on it. A read has one flight that later readers of the
/// same account join; a write or delete has a flight of its own with one waiter.
struct Flight {
    waiters: Mutex<Vec<Waiter>>,
    /// Set by the worker, under this lock, when the job ran or was skipped. A caller that times
    /// out latches only while this is false, under the same lock.
    done: Mutex<bool>,
}

impl Flight {
    fn new(waiter: Waiter) -> Arc<Self> {
        Arc::new(Self {
            waiters: Mutex::new(vec![waiter]),
            done: Mutex::new(false),
        })
    }
}

struct Job {
    account: Account,
    op: Op,
    flight: Arc<Flight>,
}

#[derive(Default)]
struct Shared {
    latched: AtomicBool,
    /// The last call ended in a locked-class failure (no latch involved).
    failing: AtomicBool,
    /// The keychain went unreachable and no call has succeeded since: the next success tells
    /// the listeners.
    outage: AtomicBool,
    listeners: Mutex<Vec<Listener>>,
    /// The queued read of each account that a new read may join. A read queued after a write or
    /// delete of the same account never joins one queued before it, or it would see the old value.
    flights: Mutex<HashMap<Account, Arc<Flight>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Worker {
    jobs: Sender<Job>,
    shared: Arc<Shared>,
    deadline: Duration,
}

impl Worker {
    pub fn start(factory: impl StoreFactory, deadline: Duration) -> Self {
        let shared = Arc::new(Shared::default());
        let (jobs, queue) = mpsc::channel();
        let runner = Runner {
            names_target: factory.names_target(),
            factory: Box::new(factory),
            store: None,
            shared: shared.clone(),
        };
        std::thread::Builder::new()
            .name("memry-keyring".to_owned())
            .spawn(move || runner.run(queue))
            .expect("the keyring thread could not start");
        Self {
            jobs,
            shared,
            deadline,
        }
    }

    pub fn is_unavailable(&self) -> bool {
        self.shared.latched.load(Ordering::Acquire) || self.shared.failing.load(Ordering::Acquire)
    }

    pub fn on_recovered(&self, listener: Listener) {
        lock(&self.shared.listeners).push(listener);
    }

    pub fn call(&self, service: &str, account: &str, op: Op) -> Reply {
        if self.shared.latched.load(Ordering::Acquire) {
            return Err(SecureStoreError::Locked);
        }
        let key = (service.to_owned(), account.to_owned());
        let (reply_to, reply) = mpsc::channel();
        let abandoned = Arc::new(AtomicBool::new(false));
        let waiter = Waiter {
            reply: reply_to,
            abandoned: abandoned.clone(),
        };
        let (flight, queued) = {
            let mut flights = lock(&self.shared.flights);
            match (matches!(op, Op::Get), flights.get(&key).cloned()) {
                (true, Some(open)) => {
                    lock(&open.waiters).push(waiter);
                    (open, None)
                }
                (is_read, _) => {
                    let flight = Flight::new(waiter);
                    if is_read {
                        flights.insert(key.clone(), flight.clone());
                    } else {
                        flights.remove(&key);
                    }
                    let job = Job {
                        account: key.clone(),
                        op,
                        flight: flight.clone(),
                    };
                    (flight, Some(job))
                }
            }
        };
        if let Some(job) = queued
            && let Err(failed) = self.jobs.send(job)
        {
            let mut flights = lock(&self.shared.flights);
            if flights
                .get(&key)
                .is_some_and(|open| Arc::ptr_eq(open, &failed.0.flight))
            {
                flights.remove(&key);
            }
            return Err(stopped());
        }
        match reply.recv_timeout(self.deadline) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                abandoned.store(true, Ordering::Release);
                let done = lock(&flight.done);
                if *done {
                    // The worker finished at the deadline: its answer, or the `Locked` of a
                    // skipped job, is on the way. Nothing is stuck, so nothing is latched.
                    drop(done);
                    return reply
                        .recv_timeout(ANSWER_GRACE)
                        .unwrap_or(Err(SecureStoreError::Locked));
                }
                self.shared.outage.store(true, Ordering::Release);
                if !self.shared.latched.swap(true, Ordering::AcqRel) {
                    tracing::warn!(
                        scope = "Keychain",
                        "the OS keychain did not answer within {:?}; keychain calls answer \"locked\" until it does",
                        self.deadline
                    );
                }
                drop(done);
                Err(SecureStoreError::Locked)
            }
            Err(RecvTimeoutError::Disconnected) => Err(stopped()),
        }
    }
}

fn stopped() -> SecureStoreError {
    SecureStoreError::Failed {
        what: "the keychain thread stopped".to_owned(),
    }
}

struct Runner {
    factory: Box<dyn StoreFactory>,
    names_target: bool,
    /// The store of the last successful call. Dropped after any failure, so the next call builds
    /// a fresh one and finds a Secret Service that started late.
    store: Option<Store>,
    shared: Arc<Shared>,
}

impl Runner {
    fn run(mut self, queue: Receiver<Job>) {
        while let Ok(job) = queue.recv() {
            if self.skip(&job) {
                continue;
            }
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| self.execute(&job)))
                .unwrap_or_else(|_| {
                    self.store = None;
                    Err(SecureStoreError::Failed {
                        what: "the credential store panicked".to_owned(),
                    })
                });
            // The job is over, so the latch of a caller that gave up on it lifts (under the
            // lock a late caller checks `done` with), then the callers are answered.
            self.complete(&job.flight);
            let recovered = match &outcome {
                Ok(_) => {
                    self.shared.failing.store(false, Ordering::Release);
                    self.shared.outage.swap(false, Ordering::AcqRel)
                }
                Err(SecureStoreError::Locked) => {
                    self.shared.failing.store(true, Ordering::Release);
                    self.shared.outage.store(true, Ordering::Release);
                    false
                }
                // The keychain answered but refused or broke: not a recovery, and not an outage.
                Err(_) => {
                    self.shared.failing.store(false, Ordering::Release);
                    false
                }
            };
            self.deliver(job, outcome);
            if recovered {
                tracing::info!(scope = "Keychain", "the OS keychain is readable again");
                self.notify_recovered();
            }
        }
    }

    /// A job nobody waits for any more is not run: a write would land after its caller was told
    /// `Locked`, and a read would show an orphan prompt. Its callers hear `Locked`.
    fn skip(&self, job: &Job) -> bool {
        let abandoned = {
            let mut flights = lock(&self.shared.flights);
            let all = lock(&job.flight.waiters)
                .iter()
                .all(|waiter| waiter.abandoned.load(Ordering::Acquire));
            // No reader joins a flight that is being dropped.
            if all
                && flights
                    .get(&job.account)
                    .is_some_and(|open| Arc::ptr_eq(open, &job.flight))
            {
                flights.remove(&job.account);
            }
            all
        };
        if abandoned {
            self.complete(&job.flight);
            for waiter in lock(&job.flight.waiters).drain(..) {
                let _ = waiter.reply.send(Err(SecureStoreError::Locked));
            }
        }
        abandoned
    }

    fn complete(&self, flight: &Flight) {
        let mut done = lock(&flight.done);
        *done = true;
        self.shared.latched.store(false, Ordering::Release);
    }

    /// Listeners run on a thread of their own, so one that calls back into the store (reload
    /// the key now that the keychain answers) is served by this worker instead of waiting on it.
    fn notify_recovered(&self) {
        let listeners: Vec<Listener> = lock(&self.shared.listeners).clone();
        if listeners.is_empty() {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("memry-keyring-recovered".to_owned())
            .spawn(move || {
                for listener in listeners {
                    listener();
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(
                scope = "Keychain",
                "the recovery listeners could not run: {error}"
            );
        }
    }

    fn deliver(&self, job: Job, outcome: Reply) {
        // Close the flight first: a read that arrives now starts a new one.
        let mut flights = lock(&self.shared.flights);
        if flights
            .get(&job.account)
            .is_some_and(|open| Arc::ptr_eq(open, &job.flight))
        {
            flights.remove(&job.account);
        }
        drop(flights);
        for waiter in lock(&job.flight.waiters).drain(..) {
            let _ = waiter.reply.send(outcome.clone());
        }
    }

    fn execute(&mut self, job: &Job) -> Reply {
        let (service, account) = &job.account;
        let store = match self.store.take() {
            Some(store) => store,
            None => self.factory.build().map_err(|e| self.classify(&e))?,
        };
        let outcome =
            entry(&store, self.names_target, service, account).and_then(|entry| match &job.op {
                Op::Get => match entry.get_secret() {
                    Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
                    // Not found is not yet absent: the platform may hold the item where this
                    // store does not look (Linux).
                    Err(Error::NoEntry) => self
                        .factory
                        .absent_check(service, account)
                        .map(|found| found.map(Zeroizing::new)),
                    Err(error) => Err(error),
                },
                Op::Set(value) => entry
                    .set_secret(value)
                    .and_then(|()| {
                        // keytar set `UserName` to the account on Windows, and the store leaves it
                        // empty when the target is named.
                        if self.names_target {
                            entry
                                .update_attributes(&HashMap::from([("username", account.as_str())]))
                        } else {
                            Ok(())
                        }
                    })
                    .map(|()| None),
                Op::Delete => match entry.delete_credential() {
                    Ok(()) | Err(Error::NoEntry) => Ok(None),
                    Err(error) => Err(error),
                },
            });
        match outcome {
            Ok(reply) => {
                self.store = Some(store);
                Ok(reply)
            }
            Err(error) => Err(self.classify(&error)),
        }
    }

    /// Logs a locked-class failure once per outage; the answer carries no platform text.
    fn classify(&self, error: &Error) -> SecureStoreError {
        let mapped = map_error(error);
        if mapped == SecureStoreError::Locked && !self.shared.failing.load(Ordering::Acquire) {
            tracing::warn!(
                scope = "Keychain",
                "the OS keychain is not readable: {error}"
            );
        }
        mapped
    }
}

/// `NoEntry` is handled by the callers and never reaches here as an error.
///
/// Everything that means "the keychain could not be reached or opened" is `Locked`, which the
/// core never treats as "no key": the master key is never discarded and the device never
/// re-registers over an unreadable entry. A malformed value or a refused write is `Failed`. No
/// answer carries secret bytes (`BadEncoding` and `BadDataFormat` hold the stored value).
pub fn map_error(error: &Error) -> SecureStoreError {
    let failed = |what: String| SecureStoreError::Failed { what };
    match error {
        Error::NoStorageAccess(_) | Error::PlatformFailure(_) | Error::NoDefaultStore => {
            SecureStoreError::Locked
        }
        Error::BadEncoding(_) => failed("the stored secret is not valid UTF-8".to_owned()),
        Error::BadDataFormat(..) => failed("the stored secret is malformed".to_owned()),
        Error::BadStoreFormat(_) => failed("the credential store data is malformed".to_owned()),
        Error::TooLong(..) | Error::Invalid(..) | Error::NotSupportedByStore(_) => {
            failed(error.to_string())
        }
        Error::Ambiguous(items) => failed(format!("{} credentials match one entry", items.len())),
        Error::NoEntry => failed("no matching credential".to_owned()),
        _ => failed("the credential store failed".to_owned()),
    }
}
