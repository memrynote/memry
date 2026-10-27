//! The keychain thread. Every OS keychain call of the app runs on one thread named
//! `memry-keyring`, never on a Tokio or Rayon thread, so a wedged D-Bus or Credential Manager
//! call cannot starve a runtime. Electron's keytar has no timeout either; its single-flight
//! queue with a 5 s deadline and an "unavailable" latch is what this ports
//! (`apps/desktop/src/main/secrets/secret-storage.ts`, `runKeytarOp`).
//!
//! A call waits at most [`DEADLINE`] for its answer. When the deadline passes, the latch is set:
//! every later call answers `Locked` at once, without queuing behind the stuck one. When the
//! stuck call finally returns, the latch lifts. The recovery listeners fire once when the keychain
//! goes from unreachable (latched, or the last call answered `Locked`) to answering, so a Secret
//! Service that starts late is reported too. An unreadable secret is never reported absent:
//! `NoEntry` is the only `Ok(None)`.

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

struct Job {
    account: Account,
    op: Op,
    /// Set by a caller that gave up. A write nobody waits for is skipped: the caller was told
    /// `Locked`, and a write that lands afterwards would contradict that answer.
    abandoned: Arc<AtomicBool>,
    /// A write answers its one caller. A read answers every caller waiting in `flights`.
    reply: Option<Sender<Reply>>,
}

#[derive(Default)]
struct Shared {
    latched: AtomicBool,
    /// The last call ended in a locked-class failure (no latch involved).
    failing: AtomicBool,
    listeners: Mutex<Vec<Listener>>,
    /// Concurrent reads of one account share one in-flight call.
    flights: Mutex<HashMap<Account, Vec<Sender<Reply>>>>,
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
        let (answer, reply) = mpsc::channel();
        let abandoned = Arc::new(AtomicBool::new(false));
        let is_read = matches!(op, Op::Get);
        let queued = if is_read {
            let mut flights = lock(&self.shared.flights);
            let waiters = flights.entry(key.clone()).or_default();
            waiters.push(answer);
            (waiters.len() == 1).then_some(Job {
                account: key.clone(),
                op,
                abandoned: abandoned.clone(),
                reply: None,
            })
        } else {
            Some(Job {
                account: key.clone(),
                op,
                abandoned: abandoned.clone(),
                reply: Some(answer),
            })
        };
        if let Some(job) = queued
            && self.jobs.send(job).is_err()
        {
            lock(&self.shared.flights).remove(&key);
            return Err(stopped());
        }
        match reply.recv_timeout(self.deadline) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                abandoned.store(true, Ordering::Release);
                if !self.shared.latched.swap(true, Ordering::AcqRel) {
                    tracing::warn!(
                        scope = "Keychain",
                        "the OS keychain did not answer within {:?}; keychain calls answer \"locked\" until it does",
                        self.deadline
                    );
                }
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
            if !matches!(job.op, Op::Get) && job.abandoned.load(Ordering::Acquire) {
                continue;
            }
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| self.execute(&job)))
                .unwrap_or_else(|_| {
                    self.store = None;
                    Err(SecureStoreError::Failed {
                        what: "the credential store panicked".to_owned(),
                    })
                });
            // The stuck call came back: lift the latch before answering, so the next caller is
            // served, then tell the listeners.
            let down = matches!(outcome, Err(SecureStoreError::Locked));
            let was_down = self.shared.latched.swap(false, Ordering::AcqRel)
                | self.shared.failing.swap(down, Ordering::AcqRel);
            self.deliver(job, outcome);
            if was_down && !down {
                tracing::info!(scope = "Keychain", "the OS keychain is readable again");
                let listeners: Vec<Listener> = lock(&self.shared.listeners).clone();
                for listener in listeners {
                    listener();
                }
            }
        }
    }

    fn deliver(&self, job: Job, outcome: Reply) {
        match job.reply {
            Some(answer) => {
                let _ = answer.send(outcome);
            }
            None => {
                let waiters = lock(&self.shared.flights)
                    .remove(&job.account)
                    .unwrap_or_default();
                for waiter in waiters {
                    let _ = waiter.send(outcome.clone());
                }
            }
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
                    Err(Error::NoEntry) => Ok(None),
                    Err(error) => Err(error),
                },
                Op::Set(value) => entry.set_secret(value).map(|()| None),
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
