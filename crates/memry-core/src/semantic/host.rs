//! The one in-memory model slot per process. The model is 330 MB resident and
//! peaks at 427 MB while loading (#4437 spike), so two copies never coexist.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::Notify;

use super::{Embed, SemanticError, Threads, Vector};
use crate::api::runtime::runtime;
use crate::domain::embedding_input::Window;

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

/// A window the model ran. A model that could not be had, or a session a
/// panic poisoned, is the `Err` around it: neither is the input's fault.
pub enum WindowOutcome {
    Embedded(Box<Vector>),
    InputFailed(SemanticError),
}

/// What the query path got instead of waiting.
#[derive(Debug, PartialEq)]
pub enum QueryVector {
    Embedded(Box<Vector>),
    /// A load is in flight, this query's or an earlier one's.
    Loading,
    /// The session was busy or the embedding failed.
    Unavailable,
}

pub struct ModelHost {
    state: Arc<Mutex<State>>,
    load: Loader,
    loaded: Arc<Notify>,
    leases: AtomicU32,
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
    /// starts a foreground load on the blocking pool and answers `Loading`,
    /// so search falls back to FTS.
    pub fn query_vector(&self, window: &Window) -> QueryVector {
        let Some(embedder) = self.loaded_or_start_load() else {
            return QueryVector::Loading;
        };
        match embedder.try_embed(window.as_str()) {
            Ok(Some(vector)) => QueryVector::Embedded(Box::new(vector)),
            Ok(None) => QueryVector::Unavailable,
            Err(error) => {
                eprintln!("memry-core: query embedding failed, FTS only: {error}");
                if matches!(error, SemanticError::Poisoned) {
                    self.evict(&embedder);
                }
                QueryVector::Unavailable
            }
        }
    }

    /// Waits for the load in flight, if any, and answers whether a model is
    /// loaded now. A load overtaken by an unload or that failed answers
    /// `false`, so a memory warning is never undone by a reload.
    pub async fn load_finished(&self) -> bool {
        let notified = self.loaded.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if matches!(lock(&self.state).slot, Slot::Loading) {
            notified.await;
        }
        matches!(lock(&self.state).slot, Slot::Loaded(_))
    }

    pub async fn embed_background(&self, input: String) -> Result<WindowOutcome, SemanticError> {
        self.leases.fetch_add(1, Ordering::SeqCst);
        let _lease = Lease(&self.leases);
        let embedder = self.background_embedder().await?;
        let outcome = runtime()
            .spawn_blocking({
                let embedder = embedder.clone();
                move || embedder.embed(&input)
            })
            .await
            .unwrap_or_else(|panicked| Err(SemanticError::inference(panicked)));
        if matches!(outcome, Err(SemanticError::Poisoned)) {
            self.evict(&embedder);
            return Err(SemanticError::Poisoned);
        }
        Ok(outcome.map_or_else(WindowOutcome::InputFailed, |vector| {
            WindowOutcome::Embedded(Box::new(vector))
        }))
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

    fn memory_warning_pending(&self) -> bool {
        self.pressure.load(Ordering::SeqCst)
    }

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
                    Slot::Loaded(_) | Slot::Unloaded if self.memory_warning_pending() => {
                        return Err(SemanticError::inference("a memory warning arrived"));
                    }
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
    use crate::domain::embedding_input::query_input;
    use crate::semantic::{DIMENSION, truncate_renormalize};

    fn q() -> Window {
        query_input("q").expect("a query")
    }

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
            counter.fetch_add(1, Ordering::SeqCst);
            assert_eq!(threads, Threads::Foreground);
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
            assert_eq!(h.host.query_vector(&q()), QueryVector::Loading);
        }
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn load_finished_returns_once_the_load_in_flight_lands() {
        let h = harness();
        assert!(
            !runtime().block_on(h.host.load_finished()),
            "nothing loaded"
        );
        h.host.query_vector(&q());
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| runtime().block_on(h.host.load_finished()));
            until(|| h.calls.load(Ordering::SeqCst) == 1);
            assert!(!waiter.is_finished(), "the load is still gated");
            h.answer.send(Outcome::Load).unwrap();
            assert!(waiter.join().unwrap(), "the model is loaded");
        });
        assert_eq!(
            h.host.query_vector(&q()),
            QueryVector::Embedded(Box::new(vector()))
        );
    }

    #[test]
    fn a_busy_session_answers_none_instead_of_waiting() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let held = fake.session.lock().unwrap();
        assert_eq!(h.host.query_vector(&q()), QueryVector::Unavailable);
        drop(held);
        assert_eq!(
            h.host.query_vector(&q()),
            QueryVector::Embedded(Box::new(vector()))
        );
    }

    #[test]
    fn a_load_that_finishes_after_an_unload_is_dropped() {
        let h = harness();
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.host.unload();
        h.answer.send(Outcome::Load).unwrap();
        until(|| {
            let built = h.built.lock().unwrap();
            built.len() == 1 && built[0].upgrade().is_none()
        });

        assert_eq!(h.host.query_vector(&q()), QueryVector::Loading);
        until(|| h.calls.load(Ordering::SeqCst) == 2);
    }

    #[test]
    fn unload_frees_a_loaded_model_and_the_next_query_reloads() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));

        h.host.unload();
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        assert_eq!(h.host.query_vector(&q()), QueryVector::Loading);
        until(|| h.calls.load(Ordering::SeqCst) == 2);
    }

    #[test]
    fn a_failed_load_is_retried_by_the_next_query() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Fail).unwrap();
        until(|| {
            h.host.query_vector(&q());
            h.calls.load(Ordering::SeqCst) == 2
        });
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));
    }

    #[test]
    fn a_panicking_load_is_retried_by_the_next_query() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Panic).unwrap();
        until(|| {
            h.host.query_vector(&q());
            h.calls.load(Ordering::SeqCst) == 2
        });
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));
    }

    #[test]
    fn a_query_after_an_unload_during_a_load_waits_for_that_load_instead_of_starting_another() {
        let h = harness();
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.host.unload();
        assert_eq!(h.host.query_vector(&q()), QueryVector::Loading);

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
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 2);
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));
    }

    #[test]
    fn a_step_waiting_on_a_load_does_not_start_another_after_a_memory_warning() {
        let h = harness();
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        std::thread::scope(|scope| {
            let step = scope.spawn(|| runtime().block_on(h.host.embed_background("w".into())));
            h.host.release(ReleaseReason::MemoryWarning);
            h.answer.send(Outcome::Load).unwrap();
            assert!(step.join().unwrap().is_err(), "the step stops");
        });
        assert_eq!(h.calls.load(Ordering::SeqCst), 1, "no second load");
        assert!(
            h.host.take_pressure(),
            "the step left the warning for stop_for"
        );
    }

    #[test]
    fn a_session_poisoned_by_a_panic_is_evicted_and_reloaded() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let poisoned = std::thread::spawn(move || {
            let _session = fake.session.lock().unwrap();
            panic!("inference panicked");
        })
        .join();
        assert!(poisoned.is_err());

        assert_eq!(h.host.query_vector(&q()), QueryVector::Unavailable);
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 2);
        h.answer.send(Outcome::Load).unwrap();
        until(|| matches!(h.host.query_vector(&q()), QueryVector::Embedded(_)));
    }
}
