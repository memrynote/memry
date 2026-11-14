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
//! | a reindex's end drains the notes it deferred           | `drainDeferredEmbeddings`                |
//! | an edit landing mid-embed stops the stale store        | `revisions`, bumped at publish           |
//! | an edit queued at close is owed and embedded on reopen | `markDirty` at publish, REVIEW-4548      |
//! | a reconcile while indexing keeps every vector          | prune after the walk                     |
//! | a rebuild while indexing loads nothing, clears nothing | prune after the walk                     |
//! | a reconcile drops the vectors of a note gone           | `reconcile`'s prune                      |
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
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use memry_core::domain::embedding_input::EMBEDDING_INPUT_VERSION;
use memry_desktop::embedding::PROJECTORS;
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::projector::{NoteEmbeddingProjector, drain_deferred};
use memry_desktop::embedding::service::{
    EMBEDDING_DIMENSION, EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IndexReport, NoteIndex};
use memry_desktop::session::projection::{CancelToken, ProjectionEvent, Projector, feed};
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
    service: Arc<EmbeddingService>,
    projector: Arc<NoteEmbeddingProjector>,
    index: Arc<NoteIndex>,
    ai: Arc<AtomicBool>,
    /// Indexing as the projector sees it, on top of the note index's own.
    indexing: Arc<AtomicBool>,
}

/// A vault with the note index and the embedding lane registered as `vault_boot` registers
/// them, opened and indexed.
fn lane() -> Lane {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    let built: Arc<OnceLock<Weak<NoteIndex>>> = Arc::default();
    let index = {
        let (built, session) = (built.clone(), e.session.clone());
        NoteIndex::new(
            e.tier.clone(),
            move |report| {
                if let (IndexReport::Indexing, Some(index)) =
                    (report, built.get().and_then(Weak::upgrade))
                {
                    drain_deferred(&session, &index);
                }
            },
            |_| {},
            |_| {},
        )
    };
    built.set(Arc::downgrade(&index)).unwrap();
    index.register(&e.session);
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
            let (indexing, index) = (indexing.clone(), Arc::downgrade(&index));
            Arc::new(move || {
                indexing.load(Ordering::SeqCst)
                    || index
                        .upgrade()
                        .is_some_and(|index| index.indexing().is_some())
            })
        },
        Arc::new(|_| {}),
    );
    e.session.register_projector(projector.clone());
    service.register(&e.session);
    feed::watch(&e.session, e.tier.subscribe()).unwrap();
    e.open();
    e.facts_until(indexed);
    e.watcher_live();
    let l = Lane {
        e,
        model,
        service,
        projector,
        index,
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

    /// The note's event, published here and now as the feed publishes it.
    fn publish(&self, note_id: &str) {
        let note_id = note_id.to_owned();
        feed::publish(
            &self.e.session,
            ProjectionEvent::NoteFileChanged { note_id },
        );
    }

    /// Every `note_files` row gone from `data.db`, as a half-built index can leave it.
    fn forget_note_files(&self) {
        self.e
            .core()
            .db_handle()
            .call_blocking(|conn| Ok(conn.execute("DELETE FROM note_files", []).unwrap()))
            .unwrap();
    }

    fn reconcile(&self) {
        let runtime = self.e.session.projections().expect("open");
        runtime.reconcile_named(&PROJECTORS).unwrap();
        self.settled();
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
    drain_deferred(&l.e.session, &l.index);
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
    drain_deferred(&l.e.session, &l.index);
    l.embedded(&id);
}

const EDITED: &str = "Alpha now holds an edited body instead.\n";

#[test]
fn a_reindex_end_drains_the_notes_it_deferred() {
    let mut l = lane();
    l.ai.store(false, Ordering::SeqCst);
    let id = l.write("a.md", ALPHA);
    l.marked(&id);
    l.settled();
    l.ai.store(true, Ordering::SeqCst);

    l.index.reindex(|_| {}).unwrap();
    l.embedded(&id);
}

#[test]
fn an_edit_landing_mid_embed_stops_the_stale_store() {
    let mut l = lane();
    let (first, reached) = l.hold_next();
    let id = l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");

    l.write("a.md", EDITED);
    l.publish(&id);
    let (second, reached) = l.hold_next();
    first.release();
    reached
        .recv_timeout(WAIT)
        .expect("the next inference reached the model");
    let next = l.model.embedded.lock().unwrap().last().cloned().unwrap();
    assert!(
        next.contains("edited body"),
        "the stale embed went on: {next}"
    );
    assert!(l.head(&id).is_none(), "the stale body was stored");

    second.release();
    l.until("the edit's vector", |l| {
        l.head_text(&id)
            .is_some_and(|text| text.contains("edited body"))
    });
    l.settled();
    assert!(l.head_text(&id).unwrap().contains("edited body"));
}

#[test]
fn an_edit_queued_at_close_is_owed_and_embedded_after_reopen() {
    let mut l = lane();
    let edited = l.write("b.md", BETA);
    l.embedded(&edited);
    l.settled();
    let (gate, reached) = l.hold_next();
    let held = l.write("a.md", ALPHA);
    reached
        .recv_timeout(WAIT)
        .expect("the lane reached the model");
    let (embeds, loads) = (l.embeds(), l.model.loads.load(Ordering::SeqCst));

    l.write("b.md", "Beta now holds an edited body instead.\n");
    l.marked(&edited);
    // The held embed resumes inside the close, after the token is set and while the lanes
    // drain, so the drained edit reaches `project` too.
    let release = gate.clone();
    l.e.session
        .on_close("release-held-embed", Arc::new(move |_| release.release()));
    l.e.close();
    assert_eq!(l.embeds(), embeds, "embedded during the close");
    assert_eq!(l.model.loads.load(Ordering::SeqCst), loads);

    l.e.open();
    l.e.facts_until(indexed);
    l.until("the edit's vector", |l| {
        l.head_text(&edited)
            .is_some_and(|text| text.contains("edited body"))
    });
    l.embedded(&held);
}

#[test]
fn a_reconcile_while_indexing_keeps_every_vector() {
    let mut l = lane();
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.embedded(id);
    }
    l.settled();

    l.indexing.store(true, Ordering::SeqCst);
    l.forget_note_files();
    l.reconcile();
    for id in &ids {
        assert_eq!(l.state(id).map(|(v, _)| v), Some(6), "{id} lost its state");
        assert!(l.head(id).is_some(), "{id} lost its vector");
    }
}

#[test]
fn a_rebuild_while_indexing_loads_no_model_and_clears_nothing() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.settled();
    l.service.stop();
    l.until("the model unloaded", |l| !l.service.status().loaded);
    let loads = l.model.loads.load(Ordering::SeqCst);
    l.indexing.store(true, Ordering::SeqCst);

    assert!(l.projector.rebuild(&CancelToken::default()).is_err());
    assert_eq!(
        l.model.loads.load(Ordering::SeqCst),
        loads,
        "a model loaded"
    );
    assert_eq!(l.state(&id).map(|(v, _)| v), Some(6));

    l.forget_note_files();
    assert!(l.projector.rebuild(&CancelToken::default()).is_err());
    assert_eq!(
        l.state(&id).map(|(v, _)| v),
        Some(6),
        "the vectors were cleared"
    );
    assert!(l.head(&id).is_some());
}

#[test]
fn a_reconcile_drops_the_vectors_of_a_note_gone() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.settled();

    l.forget_note_files();
    l.reconcile();
    assert_eq!(l.state(&id), None);
    assert!(l.head(&id).is_none());
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
