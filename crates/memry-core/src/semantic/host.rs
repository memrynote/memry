//! The one in-memory model slot per process. The model is 330 MB resident and
//! peaks at 427 MB while loading (#4437 spike), so two copies never coexist.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::{Embed, SemanticError, Threads, Vector};
use crate::api::runtime::runtime;

/// Builds an embedder for the given thread count. Runs on the blocking pool.
pub type Loader = Arc<dyn Fn(Threads) -> Result<Arc<dyn Embed>, SemanticError> + Send + Sync>;

pub struct ModelHost {
    state: Arc<Mutex<State>>,
    load: Loader,
}

struct State {
    slot: Slot,
    generation: u64,
}

enum Slot {
    Unloaded,
    /// A load that finishes and no longer matches this generation was
    /// overtaken by an unload, and drops its result.
    Loading {
        generation: u64,
    },
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
    pub fn query_vector(&self, input: &str) -> Option<Vector> {
        let embedder = self.loaded_or_start_load()?;
        match embedder.try_embed(input) {
            Ok(vector) => vector,
            Err(error) => {
                eprintln!("memry-core: query embedding failed, FTS only: {error}");
                None
            }
        }
    }

    pub fn unload(&self) {
        lock(&self.state).slot = Slot::Unloaded;
    }

    fn loaded_or_start_load(&self) -> Option<Arc<dyn Embed>> {
        let mut state = lock(&self.state);
        match &state.slot {
            Slot::Loaded(embedder) => return Some(embedder.clone()),
            Slot::Loading { .. } => return None,
            Slot::Unloaded => {}
        }
        state.generation += 1;
        let generation = state.generation;
        state.slot = Slot::Loading { generation };
        drop(state);

        let (shared, load) = (self.state.clone(), self.load.clone());
        runtime().spawn_blocking(move || {
            let loaded = load(Threads::Foreground);
            let mut state = lock(&shared);
            if !matches!(state.slot, Slot::Loading { generation: current } if current == generation)
            {
                return;
            }
            state.slot = match loaded {
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
    use std::sync::{Mutex, Weak};
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
            Ok(self.session.try_lock().ok().map(|_| vector()))
        }
    }

    /// A loader that blocks until the test answers: `true` loads a fake,
    /// `false` fails.
    struct Harness {
        host: ModelHost,
        answer: Sender<bool>,
        calls: Arc<AtomicUsize>,
        built: Arc<Mutex<Vec<Weak<Fake>>>>,
    }

    fn harness() -> Harness {
        let (answer, answers) = channel::<bool>();
        let answers = Arc::new(Mutex::new(answers));
        let calls = Arc::new(AtomicUsize::new(0));
        let built = Arc::new(Mutex::new(Vec::new()));
        let (counter, made) = (calls.clone(), built.clone());
        let load: Loader = Arc::new(move |threads| {
            assert_eq!(threads, Threads::Foreground);
            counter.fetch_add(1, Ordering::SeqCst);
            if !answers.lock().unwrap().recv().unwrap() {
                return Err(SemanticError::inference("fake load failed"));
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
        h.answer.send(true).unwrap();
        until(|| h.host.query_vector("q").is_some());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_busy_session_answers_none_instead_of_waiting() {
        let h = harness();
        h.host.query_vector("q");
        h.answer.send(true).unwrap();
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
        h.answer.send(true).unwrap();
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
        h.answer.send(true).unwrap();
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
        h.answer.send(false).unwrap();
        until(|| {
            h.host.query_vector("q");
            h.calls.load(Ordering::SeqCst) == 2
        });
        h.answer.send(true).unwrap();
        until(|| h.host.query_vector("q").is_some());
    }
}
