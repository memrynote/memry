//! The one in-memory model slot per process. The model is 330 MB resident and
//! peaks at 427 MB while loading (#4437 spike), so two copies never coexist.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::{Embed, SemanticError, Threads, Vector};
use crate::api::runtime::runtime;
use crate::domain::embedding_input::Window;

/// Builds an embedder for the given thread count. Runs on the blocking pool.
pub type Loader = Arc<dyn Fn(Threads) -> Result<Arc<dyn Embed>, SemanticError> + Send + Sync>;

pub struct ModelHost {
    state: Arc<Mutex<State>>,
    load: Loader,
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

impl ModelHost {
    pub fn new(load: Loader) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                slot: Slot::Unloaded,
                generation: 0,
            })),
            load,
        }
    }

    /// The query path, which never waits. Loaded: one `try_embed`. Unloaded:
    /// starts a foreground load on the blocking pool and answers `None`, so
    /// search falls back to FTS. Loading or busy: `None`.
    pub fn query_vector(&self, window: &Window) -> Option<Vector> {
        let embedder = self.loaded_or_start_load()?;
        match embedder.try_embed(window.as_str()) {
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

        let (shared, load) = (self.state.clone(), self.load.clone());
        runtime().spawn_blocking(move || {
            let loaded = catch_unwind(AssertUnwindSafe(|| load(Threads::Foreground)))
                .unwrap_or_else(|_| Err(SemanticError::inference("model load panicked")));
            let mut state = lock(&shared);
            state.slot = match loaded {
                Ok(_) if state.generation != generation => Slot::Unloaded,
                Ok(embedder) => Slot::Loaded(embedder),
                Err(error) => {
                    eprintln!("memry-core: embedding model load failed: {error}");
                    Slot::Unloaded
                }
            };
        });
        None
    }
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
            assert_eq!(h.host.query_vector(&q()), None);
        }
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector(&q()).is_some());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_busy_session_answers_none_instead_of_waiting() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector(&q()).is_some());

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let held = fake.session.lock().unwrap();
        assert_eq!(h.host.query_vector(&q()), None);
        drop(held);
        assert_eq!(h.host.query_vector(&q()), Some(vector()));
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

        assert_eq!(h.host.query_vector(&q()), None);
        until(|| h.calls.load(Ordering::SeqCst) == 2);
    }

    #[test]
    fn unload_frees_a_loaded_model_and_the_next_query_reloads() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector(&q()).is_some());

        h.host.unload();
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        assert_eq!(h.host.query_vector(&q()), None);
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
        until(|| h.host.query_vector(&q()).is_some());
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
        until(|| h.host.query_vector(&q()).is_some());
    }

    #[test]
    fn a_query_after_an_unload_during_a_load_waits_for_that_load_instead_of_starting_another() {
        let h = harness();
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 1);
        h.host.unload();
        assert_eq!(h.host.query_vector(&q()), None);

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
        until(|| h.host.query_vector(&q()).is_some());
    }

    #[test]
    fn a_session_poisoned_by_a_panic_is_evicted_and_reloaded() {
        let h = harness();
        h.host.query_vector(&q());
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector(&q()).is_some());

        let fake = h.built.lock().unwrap()[0].upgrade().expect("loaded");
        let poisoned = std::thread::spawn(move || {
            let _session = fake.session.lock().unwrap();
            panic!("inference panicked");
        })
        .join();
        assert!(poisoned.is_err());

        assert_eq!(h.host.query_vector(&q()), None);
        assert!(h.built.lock().unwrap()[0].upgrade().is_none());
        h.host.query_vector(&q());
        until(|| h.calls.load(Ordering::SeqCst) == 2);
        h.answer.send(Outcome::Load).unwrap();
        until(|| h.host.query_vector(&q()).is_some());
    }
}
