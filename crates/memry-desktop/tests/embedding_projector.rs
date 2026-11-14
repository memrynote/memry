//! The note embedding lane (Step 23 lane 9, #3540), after Electron's `embedding-projector.ts`,
//! on a real vault under the running tier, the shipped projection feed and a fake model.
//!
//! | Test                                                  | Rule                                     |
//! | ----------------------------------------------------- | ---------------------------------------- |
//! | a written note is embedded; an edit replaces it        | `updateEmbedding`, `markDirty`           |
//! | a removed note loses its vectors                       | `note.deleted` arm                       |
//! | with AI off a note is only marked; AI on embeds it     | `isAIEnabled`, `reconcileProjections`    |
//! | AI turned off mid-pass stops the pass                  | `canContinue`                            |
//! | while indexing a note is only marked; the drain embeds | `drainDeferredEmbeddings`                |
//! | an edit landing mid-embed leaves the edit's vector     | `revisions`, mark before embed           |
//! | a drain after close starts no model thread             | REVIEW-4548                              |
//! | a reopen with unchanged files embeds nothing           | `reconcile` owes nothing                 |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use memry_core::domain::embedding_input::EMBEDDING_INPUT_VERSION;
use memry_desktop::embedding::PROJECTORS;
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::projector::{NoteEmbeddingProjector, drain_deferred};
use memry_desktop::embedding::service::{
    EMBEDDING_DIMENSION, EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::session::projection::{ProjectionEvent, feed};
use memry_desktop::vault::consumer::Applied;
use rusqlite::OptionalExtension;
use vault_env::{Env, WAIT, env, indexed};

/// A point the fake model waits at until the test lets it go, telling the test it got there.
struct Gate {
    reached: Mutex<Sender<()>>,
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gate {
    fn new() -> (Arc<Self>, Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let gate = Arc::new(Self {
            reached: Mutex::new(tx),
            open: Mutex::new(false),
            opened: Condvar::new(),
        });
        (gate, rx)
    }

    fn wait(&self) {
        let _ = self.reached.lock().unwrap().send(());
        let open = self.open.lock().unwrap();
        let _ = self.opened.wait_timeout_while(open, WAIT, |open| !*open);
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

/// The model: counts loads, records every text it embeds, and can hold the next one.
#[derive(Default)]
struct Model {
    loads: AtomicUsize,
    embedded: Mutex<Vec<String>>,
    hold_next: Mutex<Option<Arc<Gate>>>,
}

/// A vector only `text` maps to.
fn vector(text: &str) -> Vec<f32> {
    (0..EMBEDDING_DIMENSION)
        .map(|i| {
            let mut hasher = DefaultHasher::new();
            (text, i).hash(&mut hasher);
            (hasher.finish() % 1000) as f32 / 1000.0
        })
        .collect()
}

struct FakeEngine(Arc<Model>);

impl Engine for FakeEngine {
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, String> {
        // `vault_env`'s watcher probe is a note too, and the watcher may report it again late.
        if text.contains("barrier") {
            return Ok(vector(text));
        }
        self.0.embedded.lock().unwrap().push(text.to_owned());
        let gate = self.0.hold_next.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.wait();
        }
        Ok(vector(text))
    }
}

struct Loader(Arc<Model>);

impl ModelLoader for Loader {
    fn load(
        &self,
        _: &Abort,
        _: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        self.0.loads.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeEngine(self.0.clone())))
    }
}

struct Lane {
    e: Env,
    model: Arc<Model>,
    ai: Arc<AtomicBool>,
    indexing: Arc<AtomicBool>,
}

/// A vault with the embedding lane registered as the app will, opened and indexed.
fn lane() -> Lane {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    let model = Arc::new(Model::default());
    let service = EmbeddingService::new(
        Arc::new(Loader(model.clone())),
        Arc::new(|_| {}),
        Timing::default(),
    );
    let ai = Arc::new(AtomicBool::new(true));
    let indexing = Arc::new(AtomicBool::new(false));
    let projector = NoteEmbeddingProjector::new(
        &e.session,
        service.clone(),
        {
            let ai = ai.clone();
            Arc::new(move |_| ai.load(Ordering::SeqCst))
        },
        {
            let indexing = indexing.clone();
            Arc::new(move || indexing.load(Ordering::SeqCst))
        },
        Arc::new(|_| {}),
    );
    e.session.register_projector(projector);
    service.register(&e.session);
    feed::watch(&e.session, e.tier.subscribe()).unwrap();
    e.open();
    e.facts_until(indexed);
    e.watcher_live();
    let l = Lane {
        e,
        model,
        ai,
        indexing,
    };
    l.settled();
    l
}

impl Lane {
    fn write(&mut self, rel: &str, text: &str) -> String {
        self.e.write(rel, text);
        let rel = rel.to_owned();
        let seen = self.e.facts_until(|f| match f {
            Applied::Added { path, .. } | Applied::Changed { path, .. } => *path == rel,
            _ => false,
        });
        match seen.last() {
            Some(Applied::Added { note_id, .. } | Applied::Changed { note_id, .. }) => {
                note_id.clone()
            }
            other => panic!("{other:?}"),
        }
    }

    fn query<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> T {
        let open = self.e.session.current().expect("open");
        open.search
            .index_handle()
            .call_blocking(move |conn| Ok(f(conn).unwrap()))
            .unwrap()
    }

    /// `note_embedding_state`'s `(input_version, chunk_count)` for the note.
    fn state(&self, note_id: &str) -> Option<(i64, i64)> {
        let id = note_id.to_owned();
        self.query(move |conn| {
            conn.query_row(
                "SELECT input_version, chunk_count FROM note_embedding_state WHERE note_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
    }

    /// The note's head vector in `vec_notes`.
    fn head(&self, note_id: &str) -> Option<Vec<f32>> {
        let id = note_id.to_owned();
        let blob: Option<Vec<u8>> = self.query(move |conn| {
            conn.query_row(
                "SELECT embedding FROM vec_notes WHERE note_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
        });
        blob.map(|bytes| {
            bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect()
        })
    }

    /// The text the model embedded into the note's head vector.
    fn head_text(&self, note_id: &str) -> Option<String> {
        let head = self.head(note_id)?;
        let embedded = self.model.embedded.lock().unwrap();
        embedded.iter().find(|text| vector(text) == head).cloned()
    }

    fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn embedded(&self, note_id: &str) {
        self.until("the note's vectors", |l| {
            l.state(note_id)
                .is_some_and(|(version, _)| version == i64::from(EMBEDDING_INPUT_VERSION))
        });
    }

    fn marked(&self, note_id: &str) {
        self.until("the note's dirty mark", |l| {
            l.state(note_id) == Some((0, 0))
        });
    }

    /// Every lane event published so far, and every reconcile pass, has run.
    fn settled(&self) {
        let runtime = self.e.session.projections().expect("open");
        assert!(runtime.flush(WAIT));
        self.until("the reconcile passes", |_| runtime.live_threads() <= 1);
    }

    fn embeds(&self) -> usize {
        self.model.embedded.lock().unwrap().len()
    }

    fn hold_next(&self) -> (Arc<Gate>, Receiver<()>) {
        let (gate, reached) = Gate::new();
        *self.model.hold_next.lock().unwrap() = Some(gate.clone());
        (gate, reached)
    }
}

const ALPHA: &str = "Alpha keeps the first body of this note.\n";
const BETA: &str = "Beta is a second note with enough text.\n";
const GAMMA: &str = "Gamma is a third note with enough text.\n";

#[test]
fn a_written_note_is_embedded_and_an_edit_replaces_its_vector() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    let first = l.head_text(&id).expect("a head vector of the model's");
    assert!(first.contains("first body"), "{first}");

    l.write("a.md", "Alpha now holds an edited body instead.\n");
    l.until("the edit's vector", |l| {
        l.head_text(&id)
            .is_some_and(|text| text.contains("edited body"))
    });
    assert_eq!(l.state(&id).map(|(v, _)| v), Some(6));
}

#[test]
fn a_removed_note_loses_its_vectors() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);

    fs::remove_file(l.e.vault.join("a.md")).unwrap();
    l.e.facts_until(|f| matches!(f, Applied::Removed { path, .. } if path == "a.md"));
    l.until("no vectors", |l| {
        l.state(&id).is_none() && l.head(&id).is_none()
    });
}

#[test]
fn with_ai_off_a_note_is_only_marked_until_ai_turns_on() {
    let mut l = lane();
    l.ai.store(false, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.marked(&id);
    l.settled();
    assert_eq!(l.embeds(), 0);

    l.ai.store(true, Ordering::SeqCst);
    let runtime = l.e.session.projections().unwrap();
    runtime.reconcile_named(&PROJECTORS).unwrap();
    l.embedded(&id);
}

#[test]
fn ai_turned_off_mid_pass_stops_embedding() {
    let mut l = lane();
    l.indexing.store(true, Ordering::SeqCst);
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA), ("c.md", GAMMA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.marked(id);
    }
    l.settled();
    let (gate, reached) = l.hold_next();
    l.indexing.store(false, Ordering::SeqCst);
    drain_deferred(&l.e.session);
    reached
        .recv_timeout(WAIT)
        .expect("the pass reached the model");

    l.ai.store(false, Ordering::SeqCst);
    gate.release();
    l.settled();
    assert_eq!(l.embeds(), 1, "the pass stopped after the held inference");
    for id in &ids {
        assert_eq!(l.state(id), Some((0, 0)), "{id} stays owed");
        assert!(l.head(id).is_none());
    }
}

#[test]
fn while_indexing_a_note_is_only_marked_and_the_drain_embeds_it() {
    let mut l = lane();
    l.indexing.store(true, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.marked(&id);
    l.settled();
    assert_eq!(l.embeds(), 0);

    l.indexing.store(false, Ordering::SeqCst);
    drain_deferred(&l.e.session);
    l.embedded(&id);
}

#[test]
fn an_edit_landing_mid_embed_leaves_the_edits_vector() {
    let mut l = lane();
    let (gate, reached) = l.hold_next();
    let id = l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");

    l.write("a.md", "Alpha now holds an edited body instead.\n");
    gate.release();
    l.until("the edit's vector", |l| {
        l.head_text(&id)
            .is_some_and(|text| text.contains("edited body"))
    });
    l.settled();
    let head = l.head_text(&id).unwrap();
    assert!(
        head.contains("edited body"),
        "the stale body was kept: {head}"
    );
    assert_eq!(l.state(&id).map(|(v, _)| v), Some(6));
}

#[test]
fn a_drain_after_close_starts_no_model_thread() {
    let mut l = lane();
    let (gate, reached) = l.hold_next();
    l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");
    let loads = l.model.loads.load(Ordering::SeqCst);
    let queued: Vec<String> = [("b.md", BETA), ("c.md", GAMMA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    let runtime = l.e.session.projections().unwrap();
    for note_id in queued {
        runtime.publish(ProjectionEvent::NoteFileChanged { note_id });
    }
    drop(runtime);

    l.e.close();
    gate.release();
    assert_eq!(
        l.model.loads.load(Ordering::SeqCst),
        loads,
        "a model thread loaded after close"
    );
    let embedded = l.model.embedded.lock().unwrap().clone();
    assert_eq!(embedded.len(), 1, "embedded after close: {embedded:?}");
    assert!(embedded[0].contains("Alpha"), "{embedded:?}");
}

#[test]
fn a_reopen_with_unchanged_files_embeds_nothing() {
    let mut l = lane();
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.embedded(id);
    }
    l.settled();
    let (embeds, loads) = (l.embeds(), l.model.loads.load(Ordering::SeqCst));

    l.e.close();
    l.e.open();
    l.e.facts_until(indexed);
    l.settled();
    assert_eq!(l.embeds(), embeds, "the reopen embedded again");
    assert_eq!(l.model.loads.load(Ordering::SeqCst), loads);
    for id in &ids {
        assert_eq!(l.state(id).map(|(v, _)| v), Some(6));
    }
}
