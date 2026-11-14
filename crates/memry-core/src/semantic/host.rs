//! The one in-memory model slot per process. The model is 330 MB resident and
//! peaks at 427 MB while loading (#4437 spike), so two copies never coexist.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::Notify;

use super::{Embed, SemanticError, Threads, Vector};
use crate::api::runtime::runtime;

/// Builds an embedder for the given thread count. Runs on the blocking pool.
pub type Loader = Arc<dyn Fn(Threads) -> Result<Arc<dyn Embed>, SemanticError> + Send + Sync>;

/// Why the shell asks the host to let go of the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ReleaseReason {
    /// The app left the foreground. Ignored while the embedder runs.
    Background,
    /// The OS is short of memory. Always unloads, and stops the embedder at
    /// its next step.
    MemoryWarning,
}

pub struct ModelHost {
    state: Arc<Mutex<State>>,
    load: Loader,
    /// Woken when any load ends, for a step waiting on a load it did not start.
    loaded: Arc<Notify>,
    /// Steps currently inside `embed_background`. A lease means "the embedder
    /// is running", which a background release leaves alone.
    leases: AtomicU32,
    /// A memory warning arrived since the last step looked.
    pressure: AtomicBool,
}

struct State {
    slot: Slot,
    /// Bumped by every unload. A load that finishes under a newer generation
    /// was overtaken by an unload and drops its result.
    generation: u64,
}

enum Slot {
    Unloaded,
    /// Stays until its load finishes, even across an unload, so a second
    /// model never loads beside it.
    Loading,
    Loaded(Arc<dyn Embed>),
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Lease<'h>(&'h AtomicU32);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ModelHost {
    pub fn new(load: Loader) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                slot: Slot::Unloaded,
                generation: 0,
            })),
            load,
            loaded: Arc::new(Notify::new()),
            leases: AtomicU32::new(0),
            pressure: AtomicBool::new(false),
        }
    }

    /// The query path, which never waits. Loaded: one `try_embed`. Unloaded:
    /// starts a foreground load on the blocking pool and answers `None`, so
    /// search falls back to FTS. Loading or busy: `None`.
    pub fn query_vector(&self, input: &str) -> Option<Vector> {
        let embedder = self.loaded_or_start_load()?;
        match embedder.try_embed(input) {
            Ok(vector) => vector,
            Err(error) => {
                eprintln!("memry-core: query embedding failed, FTS only: {error}");
                if matches!(error, SemanticError::Poisoned) {
                    self.evict(&embedder);
                }
                None
            }
        }
    }

    /// The step path: one window on a background (one-thread) session,
    /// waiting for a load when there is none. A foreground session is swapped
    /// for a background one, which costs one reload. Holds a lease throughout.
    pub async fn embed_background(&self, input: String) -> Result<Vector, SemanticError> {
        self.leases.fetch_add(1, Ordering::SeqCst);
        let _lease = Lease(&self.leases);
        let embedder = self.background_embedder().await?;
        let outcome = runtime()
            .spawn_blocking({
                let embedder = embedder.clone();
                move || embedder.embed(&input)
            })
            .await
            .map_err(SemanticError::inference)?;
        if matches!(outcome, Err(SemanticError::Poisoned)) {
            self.evict(&embedder);
        }
        outcome
    }

    pub fn release(&self, reason: ReleaseReason) {
        match reason {
            ReleaseReason::Background if self.leases.load(Ordering::SeqCst) > 0 => {}
            ReleaseReason::Background => self.unload(),
            ReleaseReason::MemoryWarning => {
                self.pressure.store(true, Ordering::SeqCst);
                self.unload();
            }
        }
    }

    /// Whether a memory warning arrived since the last call.
    pub fn take_pressure(&self) -> bool {
        self.pressure.swap(false, Ordering::SeqCst)
    }

    pub fn unload(&self) {
        let mut state = lock(&self.state);
        state.generation += 1;
        if let Slot::Loaded(_) = state.slot {
            state.slot = Slot::Unloaded;
        }
    }

    fn evict(&self, broken: &Arc<dyn Embed>) {
        let mut state = lock(&self.state);
        if let Slot::Loaded(current) = &state.slot
            && std::ptr::addr_eq(Arc::as_ptr(current), Arc::as_ptr(broken))
        {
            state.slot = Slot::Unloaded;
        }
    }

    fn loaded_or_start_load(&self) -> Option<Arc<dyn Embed>> {
        let mut state = lock(&self.state);
        match &state.slot {
            Slot::Loaded(embedder) => return Some(embedder.clone()),
            Slot::Loading => return None,
            Slot::Unloaded => {}
        }
        state.slot = Slot::Loading;
        let generation = state.generation;
        drop(state);

        let (shared, load, loaded) = (self.state.clone(), self.load.clone(), self.loaded.clone());
        runtime().spawn_blocking(move || {
            let _ = load_into(&shared, &load, &loaded, Threads::Foreground, generation);
        });
        None
    }

    async fn background_embedder(&self) -> Result<Arc<dyn Embed>, SemanticError> {
        loop {
            let notified = self.loaded.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let generation = {
                let mut state = lock(&self.state);
                match &state.slot {
                    Slot::Loaded(embedder) if embedder.threads() == Threads::Background => {
                        return Ok(embedder.clone());
                    }
                    Slot::Loading => None,
                    Slot::Loaded(_) | Slot::Unloaded => {
                        state.slot = Slot::Loading;
                        Some(state.generation)
                    }
                }
            };
            let Some(generation) = generation else {
                notified.await;
                continue;
            };
            let (shared, load, loaded) =
                (self.state.clone(), self.load.clone(), self.loaded.clone());
            return runtime()
                .spawn_blocking(move || {
                    load_into(&shared, &load, &loaded, Threads::Background, generation)
                })
                .await
                .map_err(SemanticError::inference)?;
        }
    }
}

/// Runs one load into the slot that was set to `Loading` under `generation`,
/// and wakes every step waiting on it.
fn load_into(
    state: &Mutex<State>,
    load: &Loader,
    loaded: &Notify,
    threads: Threads,
    generation: u64,
) -> Result<Arc<dyn Embed>, SemanticError> {
    let result = catch_unwind(AssertUnwindSafe(|| load(threads)))
        .unwrap_or_else(|_| Err(SemanticError::inference("model load panicked")));
    let mut slot = lock(state);
    let outcome = match result {
        Ok(_) if slot.generation != generation => {
            slot.slot = Slot::Unloaded;
            Err(SemanticError::inference(
                "the model was released while it loaded",
            ))
        }
        Ok(embedder) => {
            slot.slot = Slot::Loaded(embedder.clone());
            Ok(embedder)
        }
        Err(error) => {
            eprintln!("memry-core: embedding model load failed: {error}");
            slot.slot = Slot::Unloaded;
            Err(error)
        }
    };
    drop(slot);
    loaded.notify_waiters();
    outcome
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{Sender, channel};
    use std::sync::{Mutex, TryLockError, Weak};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::semantic::{DIMENSION, truncate_renormalize};

    struct Fake {
        session: Mutex<()>,
    }

    fn vector() -> Vector {
        truncate_renormalize(&[1.0; DIMENSION]).expect("finite")
    }

    impl Embed for Fake {
        fn threads(&self) -> Threads {
            Threads::Foreground
        }
        fn embed(&self, _: &str) -> Result<Vector, SemanticError> {
            let _session = self.session.lock().expect("fake session");
            Ok(vector())
        }
        fn try_embed(&self, _: &str) -> Result<Option<Vector>, SemanticError> {
            match self.session.try_lock() {
                Ok(_) => Ok(Some(vector())),
                Err(TryLockError::WouldBlock) => Ok(None),
                Err(TryLockError::Poisoned(_)) => Err(SemanticError::Poisoned),
            }
        }
    }

    enum Outcome {
        Load,
        Fail,
        Panic,
    }

    /// A loader that blocks until the test answers with an `Outcome`.
    struct Harness {
        host: ModelHost,
        answer: Sender<Outcome>,
        calls: Arc<AtomicUsize>,
        built: Arc<Mutex<Vec<Weak<Fake>>>>,
    }

    fn harness() -> Harness {
        let (answer, answers) = channel::<Outcome>();
        let answers = Arc::new(Mutex::new(answers));
        let calls = Arc::new(AtomicUsize::new(0));
        let built = Arc::new(Mutex::new(Vec::new()));
        let (counter, made) = (calls.clone(), built.clone());
        let load: Loader = Arc::new(move |threads| {
            assert_eq!(threads, Threads::Foreground);
            counter.fetch_add(1, Ordering::SeqCst);
            // Bound before the match: panicking with the guard alive would
            // poison `answers` for every later load.
            let outcome = answers.lock().unwrap().recv().unwrap();
            match outcome {
                Outcome::Load => {}
                Outcome::Fail => return Err(SemanticError::inference("fake load failed")),
                Outcome::Panic => panic!("fake load panicked"),
            }
            let fake = Arc::new(Fake {
                session: Mutex::new(()),
            });
            made.lock().unwrap().push(Arc::downgrade(&fake));
            Ok(fake as Arc<dyn Embed>)
        });
        Harness {
            host: ModelHost::new(load),
            answer,
            calls,
            built,
        }
    }

    /// Waits for an event on the blocking pool. The deadline only bounds a
    /// hang; no assertion depends on how fast the event happens.
    fn until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "event never happened");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn a_cold_query_starts_one_load_and_answers_none_until_it_finishes() {
        let h = harness();
        for _ in 0..3 {
            assert_eq!(h.host.query_vector("q"), None);
        }
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_busy_session_answers_none_instead_of_waiting() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let held = fake.session.lock().unwrap();
        assert_eq!(h.host.query_vector("q"), None);
        drop(held);
        assert_eq!(h.host.query_vector("q"), Some(vector()));
    }

    #[test]
    fn a_load_that_finishes_after_an_unload_is_dropped() {
        let h = harness();
        h.host.query_vector("q");
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.host.unload();
        h.answer.send(Outcome::Load).unwrap();
        until(|| {
            let built = h.built.lock().unwrap();
            built.len() == 1 && built[0].upgrade().is_none()
        });

        assert_eq!(h.host.query_vector("q"), None);
        until(|| h.calls.load(Ordering::SeqCst) == 2);
    }

    #[test]
    fn unload_frees_a_loaded_model_and_the_next_query_reloads() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());

        h.host.unload();
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        assert_eq!(h.host.query_vector("q"), None);
        until(|| h.calls.load(Ordering::SeqCst) == 2);
    }

    #[test]
    fn a_failed_load_is_retried_by_the_next_query() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(Outcome::Fail).unwrap();
        until(|| {
            h.host.query_vector("q");
            h.calls.load(Ordering::SeqCst) == 2
        });
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());
    }

    #[test]
    fn a_panicking_load_is_retried_by_the_next_query() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(Outcome::Panic).unwrap();
        until(|| {
            h.host.query_vector("q");
            h.calls.load(Ordering::SeqCst) == 2
        });
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());
    }

    #[test]
    fn a_query_after_an_unload_during_a_load_waits_for_that_load_instead_of_starting_another() {
        let h = harness();
        h.host.query_vector("q");
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.host.unload();
        assert_eq!(h.host.query_vector("q"), None);

        // The blocking pool is FIFO: once this marker has run, a second load
        // spawned by the query above has started too.
        let (ran, marker) = channel();
        runtime().spawn_blocking(move || ran.send(()).unwrap());
        marker.recv().unwrap();
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);

        h.answer.send(Outcome::Load).unwrap();
        until(|| {
            let built = h.built.lock().unwrap();
            built.len() == 1 && built[0].upgrade().is_none()
        });
        h.host.query_vector("q");
        until(|| h.calls.load(Ordering::SeqCst) == 2);
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());
    }

    #[test]
    fn a_session_poisoned_by_a_panic_is_evicted_and_reloaded() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let poisoned = std::thread::spawn(move || {
            let _session = fake.session.lock().unwrap();
            panic!("inference panicked");
        })
        .join();
        assert!(poisoned.is_err());

        assert_eq!(h.host.query_vector("q"), None);
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        h.host.query_vector("q");
        until(|| h.calls.load(Ordering::SeqCst) == 2);
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector("q").is_some());
    }
}
