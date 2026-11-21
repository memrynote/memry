//! The embedding lane's test harness: a real vault under the running tier, the note index and
//! the embedding lane registered as `vault_boot` registers them, the shipped projection feed and
//! a fake model.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use memry_core::domain::embedding_input::EMBEDDING_INPUT_VERSION;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::embedding::PROJECTORS;
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::projector::{NoteEmbeddingProjector, drain_deferred};
use memry_desktop::embedding::service::{
    EMBEDDING_DIMENSION, EmbedError, EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::notes::index::{IndexReport, NoteIndex};
use memry_desktop::session::projection::{ProjectionEvent, feed};
use memry_desktop::vault::consumer::Applied;
use rusqlite::OptionalExtension;

use crate::vault_env::files_too::files_too;
use crate::vault_env::{Env, WAIT, edit_in_app, env, indexed};

/// A point the fake model waits at until the test lets it go, telling the test it got there.
pub struct Gate {
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

    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

/// The model: counts loads, records every text it embeds, and can hold the next one.
#[derive(Default)]
pub struct Model {
    pub loads: AtomicUsize,
    pub embedded: Mutex<Vec<String>>,
    hold_next: Mutex<Option<Arc<Gate>>>,
}

/// A vector only `text` maps to.
pub fn vector(text: &str) -> Vec<f32> {
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
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
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

pub struct Lane {
    pub e: Env,
    pub model: Arc<Model>,
    pub service: Arc<EmbeddingService>,
    pub projector: Arc<NoteEmbeddingProjector>,
    pub index: Arc<NoteIndex>,
    pub ai: Arc<AtomicBool>,
    /// Indexing as the projector sees it, on top of the note index's own.
    pub indexing: Arc<AtomicBool>,
    store: Arc<dyn SecureStore>,
}

/// A vault with the note index and the embedding lane registered as `vault_boot` registers
/// them, opened and indexed.
pub fn lane() -> Lane {
    let kept = Mutex::new(None);
    let mut e = env(|store| {
        *kept.lock().unwrap() = Some(store.clone());
        // Filed PDFs and images get notes too, as the app's identity gives them.
        Some(files_too(store))
    });
    let store = kept.into_inner().unwrap().unwrap();
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
        store,
    };
    l.settled();
    l
}

impl Lane {
    pub fn write(&mut self, rel: &str, text: &str) -> String {
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

    /// The note's first block retyped in the app, its write-back scheduled as the editor
    /// schedules it: the file and its `note_files` row change once the debounce ends.
    pub fn edit(&self, note_id: &str, text: &str) {
        edit_in_app(&self.e.core(), &self.store, note_id, text);
        self.e.tier.schedule(note_id);
    }

    /// The live notes the reconcile would embed.
    pub fn owed(&self) -> Vec<String> {
        let open = self.e.session.current().expect("open");
        let owed = open.search.owed_note_embeddings().unwrap();
        owed.into_iter().map(|note| note.note_id).collect()
    }

    /// The note's event, published here and now as the feed publishes it.
    pub fn publish(&self, note_id: &str) {
        let note_id = note_id.to_owned();
        feed::publish(
            &self.e.session,
            ProjectionEvent::NoteFileChanged { note_id },
        );
    }

    /// Every `note_files` row gone from `data.db`, as a half-built index can leave it.
    pub fn forget_note_files(&self) {
        self.e
            .core()
            .db_handle()
            .call_blocking(|conn| Ok(conn.execute("DELETE FROM note_files", []).unwrap()))
            .unwrap();
    }

    pub fn reconcile(&self) {
        let runtime = self.e.session.projections().expect("open");
        runtime.reconcile_named(&PROJECTORS).unwrap();
        self.settled();
    }

    pub fn query<T: Send + 'static>(
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
    pub fn state(&self, note_id: &str) -> Option<(i64, i64)> {
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
    pub fn head(&self, note_id: &str) -> Option<Vec<f32>> {
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
    pub fn head_text(&self, note_id: &str) -> Option<String> {
        let head = self.head(note_id)?;
        let embedded = self.model.embedded.lock().unwrap();
        embedded.iter().find(|text| vector(text) == head).cloned()
    }

    pub fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(Instant::now() < deadline, "still waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn embedded(&self, note_id: &str) {
        self.until("the note's vectors", |l| {
            l.state(note_id)
                .is_some_and(|(version, _)| version == i64::from(EMBEDDING_INPUT_VERSION))
        });
    }

    /// Waits until the reconcile owes the note a vector.
    pub fn owes(&self, note_id: &str) {
        self.until("the note owed", |l| l.owed().iter().any(|id| id == note_id));
    }

    /// Every live note has its vectors. The feed publishes a fact on its own thread and the
    /// embedding lane is a background one (`flush` skips it), so only the stored vectors show
    /// that the events a write owed were published and embedded.
    pub fn all_embedded(&self) {
        self.until("every note embedded", |l| l.owed().is_empty());
        self.settled();
    }

    /// Every event published so far to a foreground lane has run, and no reconcile pass is
    /// running. The embedding lane is a background one, which `flush` skips: a test that needs
    /// its work done waits on the stored vectors ([`Self::embedded`], [`Self::all_embedded`]).
    pub fn settled(&self) {
        let runtime = self.e.session.projections().expect("open");
        assert!(runtime.flush(WAIT));
        self.until("the reconcile passes", |_| runtime.live_threads() <= 1);
    }

    pub fn embeds(&self) -> usize {
        self.model.embedded.lock().unwrap().len()
    }

    pub fn hold_next(&self) -> (Arc<Gate>, Receiver<()>) {
        let (gate, reached) = Gate::new();
        *self.model.hold_next.lock().unwrap() = Some(gate.clone());
        (gate, reached)
    }
}

pub const ALPHA: &str = "Alpha keeps the first body of this note.\n";
pub const BETA: &str = "Beta is a second note with enough text.\n";
pub const GAMMA: &str = "Gamma is a third note with enough text.\n";
