//! `FoldService` over a running vault (Step 14h, #3531; model levels, Step 22 #3539): a long
//! note and a journal day fold from their files, a fold never waits on `index.db`'s writer (the
//! Brief is picked again, never cached), a short or unknown note does not fold, and the service
//! lets go of the vault when it closes. [`Fake`] is the model backend the queue tests run on.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use async_trait::async_trait;
use memry_core::api::search::Search;
use memry_core::domain::fold_chunks::ChunkKey;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::ai::features::SUMMARIZE_LONG_NOTES_KEY;
use memry_desktop::fold::agent::FoldAgentChoice;
use memry_desktop::fold::engine::prepare;
use memry_desktop::fold::queue::{FoldBackend, FoldWriter};
use memry_desktop::fold::service::FoldService;
use memry_desktop::fold::tokens::Zone;
use memry_desktop::fold::{FoldLayers, FoldLevel, FoldStatus};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::AppConfig;
use memry_desktop::settings::SettingsService;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::Semaphore;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use vault_env::{Env, env, indexed};

const SENTENCE: &str = "The fold keeps the sentence that carries each paragraph of a long note.";
pub const MODEL_ID: &str = "fake:model";
/// How long a test waits for something that must happen.
pub const WAIT: Duration = Duration::from_secs(30);

fn long_note(paragraphs: usize) -> String {
    let paragraph =
        format!("{SENTENCE} It drops the rest until the reader opens it again. Is that enough?");
    let mut text = String::from("# Plan\n\n");
    for _ in 0..paragraphs {
        text.push_str(&paragraph);
        text.push_str("\n\n");
    }
    text
}

/// A note of `sections` headed sections of two distinct paragraphs each: one chunk a section.
pub fn sectioned(sections: usize, seed: &str) -> String {
    let mut text = String::new();
    for s in 0..sections {
        text.push_str(&format!("# Part {s} of {seed}\n\n"));
        for p in 0..2 {
            text.push_str(&format!(
                "Paragraph {p} of part {s} in {seed} says one plain thing about the plan. \
                 It adds a second sentence so the brief has a choice to make.\n\n"
            ));
        }
    }
    text
}

/// The cache keys of `text`'s chunks under the fake's model.
pub fn chunk_keys(text: &str) -> Vec<ChunkKey> {
    let prepared = prepare(text, Zone::Local);
    prepared
        .sections
        .iter()
        .flat_map(|s| &s.chunks)
        .map(|chunk| ChunkKey {
            chunk_hash: chunk.hash.clone(),
            language: prepared.language.clone(),
            model_id: MODEL_ID.to_owned(),
        })
        .collect()
}

/// What the fake answers a run.
pub enum Reply {
    /// A reply of the chunk's shape.
    Valid,
    Fail,
    Raw(Value),
}

/// A model backend: one agent while `available` holds, runs that wait on `gate`, and replies
/// from `replies` (valid once it runs dry).
pub struct Fake {
    pub available: AtomicBool,
    /// Runs wait on [`Fake::gate`] while this is false.
    pub open: AtomicBool,
    pub gate: Semaphore,
    pub replies: Mutex<VecDeque<Reply>>,
    pub prompts: Mutex<Vec<String>>,
    running: AtomicUsize,
    pub peak: AtomicUsize,
    pub forgets: AtomicUsize,
    started: UnboundedSender<String>,
    replied: UnboundedSender<String>,
}

impl Fake {
    pub fn runs(&self) -> usize {
        self.prompts.lock().unwrap().len()
    }

    pub fn reply(&self, replies: impl IntoIterator<Item = Reply>) {
        self.replies.lock().unwrap().extend(replies);
    }
}

/// The reply a model gives `prompt`: one entry per `Paragraph n:` line.
pub fn valid_reply(prompt: &str) -> Value {
    let count = prompt
        .lines()
        .filter(|line| line.starts_with("Paragraph "))
        .count();
    let paragraphs: Vec<Value> = (0..count)
        .map(|i| {
            json!({
                "brief": [0],
                "key": { "takeaway": format!("Claim {i} holds."), "reason": "The text says so." },
                "takeaway": format!("Takeaway {i}."),
                "topic": "Plain plan",
                "evidence": [0],
            })
        })
        .collect();
    json!({ "sectionTakeaway": "The section in one line.", "paragraphs": paragraphs })
}

#[async_trait]
impl FoldBackend for Fake {
    async fn writer(&self, _choice: FoldAgentChoice) -> Option<FoldWriter> {
        self.available.load(Ordering::SeqCst).then(|| FoldWriter {
            id: FoldAgentChoice::LocalOpenaiCompatible,
            label: "Fake model".into(),
            model_id: MODEL_ID.into(),
        })
    }

    async fn run(&self, _writer: &FoldWriter, prompt: &str) -> Result<Value, String> {
        self.prompts.lock().unwrap().push(prompt.to_owned());
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        let _ = self.started.send(prompt.to_owned());
        if !self.open.load(Ordering::SeqCst) {
            self.gate.acquire().await.expect("open gate").forget();
        }
        self.running.fetch_sub(1, Ordering::SeqCst);
        let _ = self.replied.send(prompt.to_owned());
        match self.replies.lock().unwrap().pop_front() {
            None | Some(Reply::Valid) => Ok(valid_reply(prompt)),
            Some(Reply::Fail) => Err("the model exited".into()),
            Some(Reply::Raw(value)) => Ok(value),
        }
    }

    fn forget(&self) {
        self.forgets.fetch_add(1, Ordering::SeqCst);
    }
}

pub struct World {
    pub e: Env,
    pub fold: Arc<FoldService>,
    pub fake: Arc<Fake>,
    pub settings: SettingsService,
    /// Every `note-fold:updated`, by note id.
    pub updates: UnboundedReceiver<String>,
    /// Every run the fake started, by prompt.
    pub started: UnboundedReceiver<String>,
    pub replied: UnboundedReceiver<String>,
}

/// A vault holding `files`, open and indexed, folded on the current runtime with an agent
/// available and runs that do not wait. Summaries are off until [`World::summarize`].
pub fn world(files: &[(&str, &str)], idle: Duration) -> World {
    world_on(files, idle, None)
}

/// [`world`] with `backend` writing the model levels instead of [`World::fake`].
pub fn world_on(
    files: &[(&str, &str)],
    idle: Duration,
    backend: Option<Arc<dyn FoldBackend>>,
) -> World {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (path, text) in files {
        e.write(path, text);
    }
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let config = Arc::new(AppConfig::load(e._dir.path().join("app/memry-config.json")));
    let settings = SettingsService::new(store, config);
    let (started_tx, started) = unbounded_channel();
    let (replied_tx, replied) = unbounded_channel();
    let fake = Arc::new(Fake {
        available: AtomicBool::new(true),
        open: AtomicBool::new(true),
        gate: Semaphore::new(0),
        replies: Mutex::default(),
        prompts: Mutex::default(),
        running: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        forgets: AtomicUsize::new(0),
        started: started_tx,
        replied: replied_tx,
    });
    let (updated, updates) = unbounded_channel();
    let fold = FoldService::with_idle(
        notes,
        settings.clone(),
        backend.unwrap_or_else(|| fake.clone()),
        Handle::current(),
        Arc::new(move |id: &str| {
            let _ = updated.send(id.to_owned());
        }),
        idle,
    );
    fold.register(&e.session);
    e.open();
    e.facts_until(indexed);
    World {
        e,
        fold,
        fake,
        settings,
        updates,
        started,
        replied,
    }
}

impl World {
    pub fn summarize(&self, on: bool) {
        let open = self.e.session.current().expect("open");
        self.settings
            .set_local_text(
                Some(&open),
                SUMMARIZE_LONG_NOTES_KEY,
                if on { "true" } else { "false" },
            )
            .expect("write the setting");
    }

    /// Runs wait until [`World::release`].
    pub fn hold_runs(&self) {
        self.fake.open.store(false, Ordering::SeqCst);
    }

    /// Lets `runs` held runs go on.
    pub fn release(&self, runs: usize) {
        self.fake.gate.add_permits(runs);
    }

    /// Runs stop waiting, the held ones included.
    pub fn release_all(&self) {
        self.fake.open.store(true, Ordering::SeqCst);
        self.fake.gate.add_permits(64);
    }

    pub fn id_of(&self, path: &str) -> String {
        id_of(&self.e, path)
    }

    pub fn search(&self) -> Arc<Search> {
        self.e.session.current().expect("open").search.clone()
    }

    pub async fn get(&self, id: &str) -> FoldLayers {
        self.fold.get(id).await.expect("fold")
    }

    pub async fn next_update(&mut self) -> String {
        tokio::time::timeout(WAIT, self.updates.recv())
            .await
            .expect("an update in time")
            .expect("open channel")
    }

    pub async fn next_start(&mut self) -> String {
        tokio::time::timeout(WAIT, self.started.recv())
            .await
            .expect("a run started in time")
            .expect("open channel")
    }

    /// Folds `id` again until it reads `status`, after each update of it.
    pub async fn until_status(&mut self, id: &str, status: FoldStatus) -> FoldLayers {
        for _ in 0..50 {
            let layers = self.get(id).await;
            if layers.status == status {
                return layers;
            }
            while self.next_update().await != id {}
        }
        panic!("{id} never read {status:?}");
    }
}

pub fn id_of(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(id, _)| id)
        .expect("the note's row")
}

fn briefs(layers: &FoldLayers) -> Vec<Vec<u32>> {
    layers
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .map(|p| p.brief_idx.clone())
        .collect()
}

const IDLE: Duration = Duration::from_secs(30);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_long_note_folds_to_its_brief() {
    let w = world(&[("plan.md", &long_note(8))], IDLE);
    let id = w.id_of("plan.md");

    let layers = w.fold.run(&id, FoldLevel::Brief).await.expect("fold");
    assert_eq!(layers.status, FoldStatus::Off);
    assert_eq!(layers.note_id, id);
    assert_eq!(layers.sections[0].heading.as_deref(), Some("Plan"));
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
    // Each paragraph's first sentence: first, a claim of 6 to 30 words, no question.
    assert!(briefs(&layers).iter().all(|b| b == &[0]));
    assert_eq!(layers.sections[0].paragraphs[0].sentences[0], SENTENCE);

    // Full folds the same snapshot.
    assert_eq!(
        w.fold.run(&id, FoldLevel::Full).await.expect("fold"),
        layers
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fold_never_waits_on_the_index_writer() {
    let w = world(&[("plan.md", &long_note(8))], IDLE);
    let id = w.id_of("plan.md");
    // The writer is held, as a reindex pass holds it for its whole transaction, until the
    // fold is back: a fold that wrote to `index.db` would wait for ever.
    let (held, writer_held) = mpsc::channel();
    let (folded, fold_done) = mpsc::channel::<()>();
    let search = w.search();
    let writer = std::thread::spawn(move || {
        search
            .index_handle()
            .call_blocking(move |_| {
                held.send(()).expect("held");
                fold_done.recv_timeout(Duration::from_secs(30)).ok();
                Ok(())
            })
            .expect("hold");
    });
    writer_held.recv().expect("the writer is held");
    let layers = tokio::time::timeout(Duration::from_secs(10), w.fold.run(&id, FoldLevel::Brief))
        .await
        .expect("the fold answered with the writer held")
        .expect("fold");
    assert_eq!(layers.status, FoldStatus::Off);
    folded.send(()).expect("release");
    writer.join().expect("writer");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_short_or_unknown_note_does_not_fold() {
    let w = world(
        &[("short.md", "A few words are not worth folding.\n")],
        IDLE,
    );
    w.summarize(true);
    let id = w.id_of("short.md");
    for note in [id.as_str(), "no-such-note"] {
        let layers = w.get(note).await;
        assert_eq!(layers.status, FoldStatus::Short);
        assert!(layers.sections.is_empty());
        assert_eq!(layers.words_by_level.brief, 0);
        assert_eq!(layers.agent, None);
    }
    assert_eq!(w.fake.runs(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_journal_day_folds_from_its_file() {
    let w = world(&[("journal/2025-01-17.md", &long_note(8))], IDLE);
    let layers = w.get("j2025-01-17").await;
    assert_eq!(layers.status, FoldStatus::Off);
    assert_eq!(layers.sections[0].paragraphs.len(), 8);
}

/// A deleted day reads as no day, as Electron's lookup of live days answers: its id does not
/// fold the file still at its date.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_journal_day_does_not_fold() {
    let w = world(&[("journal/2025-01-17.md", &long_note(8))], IDLE);
    let data = rusqlite::Connection::open(w.e.vault.join(".memry/core/data.db")).expect("data.db");
    data.execute(
        "UPDATE journal_entries SET deleted_at = 1 WHERE id = 'j2025-01-17'",
        [],
    )
    .expect("delete the day");
    let layers = w.get("j2025-01-17").await;
    assert_eq!(layers.status, FoldStatus::Short);
    assert!(layers.sections.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_service_lets_go_of_the_vault_when_it_closes() {
    let mut w = world(&[("plan.md", &long_note(8))], IDLE);
    let id = w.id_of("plan.md");
    w.get(&id).await;
    w.e.close();
    assert!(matches!(
        w.fold.run(&id, FoldLevel::Brief).await,
        Err(NotesError::Closed)
    ));
    // Nothing of the closed vault is held: it opens again.
    w.e.open();
    assert_eq!(w.get(&id).await.status, FoldStatus::Off);
}
