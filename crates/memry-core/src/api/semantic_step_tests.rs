//! The step on a real vault (`Vault::open`, real SQLite, real `vectors.db`)
//! with a fake embedder behind the real model slot.

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};

use super::*;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::update_log;
use crate::domain::notes::{self, NewNote};
use crate::semantic::fakes::{Cdn, Scratch, Wifi, files, manifest};
use crate::semantic::{DIMENSION, Embed, Loader, Threads, Vector, truncate_renormalize};
use crate::storage::vector_db::NoteState;

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const ROOMY: u64 = 1 << 40;
const COOL: StepConditions = StepConditions {
    thermal: Thermal::Nominal,
    external_power: true,
};

/// Each window takes at least 5 ms, so a measured window is never zero.
struct Fake {
    gate: Option<Arc<Mutex<Receiver<()>>>>,
    entered: Option<Sender<()>>,
}

impl Embed for Fake {
    fn threads(&self) -> Threads {
        Threads::Background
    }
    fn embed(&self, input: &str) -> Result<Vector, SemanticError> {
        if let Some(entered) = &self.entered {
            let _ = entered.send(());
        }
        if let Some(gate) = &self.gate {
            gate.lock().unwrap().recv().unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
        let mut values = [1.0; DIMENSION];
        values[0] += input.len() as f32;
        truncate_renormalize(&values)
    }
    fn try_embed(&self, input: &str) -> Result<Option<Vector>, SemanticError> {
        self.embed(input).map(Some)
    }
}

/// Blocks each window until the test sends, and says when one starts.
type Gate = (Arc<Mutex<Receiver<()>>>, Sender<()>);
type Docs = HashMap<String, (Arc<Document>, Arc<Mutex<Vec<u8>>>)>;

struct Setup {
    scratch: Scratch,
    loads: Arc<AtomicUsize>,
    semantic: SemanticSearch,
    vault: Arc<Vault>,
}

fn loader(loads: Arc<AtomicUsize>, gate: Option<Gate>) -> Loader {
    Arc::new(move |_| {
        loads.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Fake {
            gate: gate.as_ref().map(|(gate, _)| gate.clone()),
            entered: gate.as_ref().map(|(_, entered)| entered.clone()),
        }) as Arc<dyn Embed>)
    })
}

impl Setup {
    /// A second object over the same models directory and vault, as after a
    /// relaunch.
    fn relaunch(&mut self) {
        self.semantic = self.build(None);
    }

    fn build(&self, gate: Option<Gate>) -> SemanticSearch {
        let files = files();
        SemanticSearch::with_loader(
            self.scratch.models(manifest(&files)),
            Cdn::new(&files),
            Wifi::on(),
            loader(self.loads.clone(), gate),
        )
    }

    async fn step(&self) -> StepOutcome {
        self.semantic
            .embed_step(self.vault.clone(), COOL)
            .await
            .unwrap()
    }

    async fn finish(&self) -> (u32, u32) {
        for _ in 0..200 {
            if let StepOutcome::Finished { embedded, total } = self.step().await {
                return (embedded, total);
            }
        }
        panic!("the queue never finished");
    }

    fn states(&self) -> Vec<NoteState> {
        vector_db::open(&self.vault.directory().join("vectors.db"), true)
            .unwrap()
            .unwrap()
            .call_blocking(|conn| VectorStore::new(conn).states())
            .unwrap()
    }

    fn window_rows(&self, note_id: &str) -> u32 {
        let id = note_id.to_owned();
        vector_db::open(&self.vault.directory().join("vectors.db"), true)
            .unwrap()
            .unwrap()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT count(*) FROM note_vectors WHERE note_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .unwrap()
    }

    fn write(&self, id: &str, title: &str, body: &str) {
        self.vault
            .db_handle()
            .call_blocking(|conn: &mut Connection| {
                let note = NewNote {
                    id,
                    title,
                    folder_path: None,
                    content: "",
                    tags: &[],
                    properties: None,
                    emoji: None,
                };
                notes::create(conn, &note, DEVICE, NOW)?;
                append_body(conn, id, 1, body);
                Ok(())
            })
            .unwrap();
        self.reindex();
    }

    fn edit_body(&self, id: &str, seq: i64, body: &str) {
        self.vault
            .db_handle()
            .call_blocking(|conn: &mut Connection| {
                append_body(conn, id, seq, body);
                Ok(())
            })
            .unwrap();
        self.reindex();
    }

    fn with_data(&self, f: impl FnOnce(&Connection)) {
        self.vault
            .db_handle()
            .call_blocking(|conn: &mut Connection| {
                f(conn);
                Ok(())
            })
            .unwrap();
        self.reindex();
    }

    /// The app reindexes after every write, which refreshes the body cache
    /// the queue plans from.
    fn reindex(&self) {
        self.vault.search().unwrap().reindex().unwrap();
    }

    fn source_key_of(&self, id: &str) -> [u8; 32] {
        let id = id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| queue::sources(conn))
            .unwrap()
            .into_iter()
            .find(|source| source.note_id == id)
            .unwrap()
            .source_key
    }
}

async fn setup() -> Setup {
    let scratch = Scratch::new();
    let vault_dir = scratch.0.join("vault");
    fs::create_dir_all(&vault_dir).unwrap();
    let vault = Arc::new(Vault::open("v1".into(), vault_dir.to_string_lossy().into()).unwrap());
    let loads = Arc::new(AtomicUsize::new(0));
    let files = files();
    let semantic = SemanticSearch::with_loader(
        scratch.models(manifest(&files)),
        Cdn::new(&files),
        Wifi::on(),
        loader(loads.clone(), None),
    );
    let setup = Setup {
        scratch,
        loads,
        semantic,
        vault,
    };
    setup.semantic.enable(ROOMY).await.unwrap();
    setup
}

/// Writes `text` as a new paragraph in the note's one document, so every
/// edit extends the same block group the first write made.
fn append_body(conn: &Connection, id: &str, seq: i64, text: &str) {
    thread_local! {
        static DOCS: std::cell::RefCell<Docs> =
            Default::default();
    }
    let (document, last) = DOCS.with(|docs| {
        docs.borrow_mut()
            .entry(id.to_owned())
            .or_insert_with(|| {
                let last: Arc<Mutex<Vec<u8>>> = Arc::default();
                let sink: UpdateSink = {
                    let last = last.clone();
                    Arc::new(move |_, bytes: &[u8]| *last.lock().unwrap() = bytes.to_vec())
                };
                let document = DocumentRegistry::new("device-peer", sink)
                    .get_or_open(id)
                    .unwrap();
                (document, last)
            })
            .clone()
    });
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").unwrap();
            let group = match fragment.get(txn, 0) {
                Some(XmlOut::Element(group)) => group,
                _ => fragment.push_back(txn, XmlElementPrelim::empty("blockGroup")),
            };
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new(text));
        })
        .unwrap();
    let update = last.lock().unwrap().clone();
    // Stamped by the real clock, as the reindex watermark is.
    update_log::append_server_update(conn, id, seq, &update, now_ms()).unwrap();
}

fn long_body() -> String {
    "a sentence about embedding windows. ".repeat(300)
}

#[tokio::test]
async fn steps_run_until_finished_and_count_up() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    s.write("b", "Beta", "the second note body");
    s.write("c", "Gamma", "");

    let mut counts = Vec::new();
    loop {
        match s.step().await {
            StepOutcome::Embedded {
                embedded, total, ..
            } => counts.push((embedded, total)),
            StepOutcome::Finished { embedded, total } => {
                counts.push((embedded, total));
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(counts, vec![(1, 3), (2, 3), (3, 3), (3, 3)]);
    let states = s.states();
    assert_eq!(states.len(), 3);
    assert_eq!(
        states[2].window_count, 0,
        "a body too short to embed is done"
    );
    assert_eq!(s.semantic.status(s.vault.clone()).embedded_notes, 3);
}

#[tokio::test]
async fn missing_notes_are_embedded_before_stale_ones_and_a_rename_or_edit_requeues_only_that_note()
{
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    s.write("b", "Beta", "the second note body");
    s.finish().await;
    let before = s.states();

    s.with_data(|conn| {
        notes::rename(conn, "a", "Alpha renamed", DEVICE, NOW).unwrap();
    });
    s.write("z", "Zeta", "a note added after the first pass");
    s.step().await;
    let ids: Vec<String> = s.states().into_iter().map(|state| state.note_id).collect();
    assert_eq!(ids, ["a", "b", "z"], "the new note came first");
    assert_eq!(s.states()[0], before[0], "the renamed note waits behind it");

    s.finish().await;
    let after = s.states();
    assert_ne!(
        after[0].source_key, before[0].source_key,
        "the rename re-embedded a"
    );
    assert_eq!(after[1], before[1], "b was left alone");

    s.edit_body("b", 2, "an edit appended to the body");
    let plan_due = s.source_key_of("b");
    assert_ne!(plan_due, after[1].source_key, "the edit makes b due");
    s.finish().await;
    assert_eq!(s.states()[1].source_key, plan_due);
    assert_eq!(s.states()[0], after[0], "a was left alone");
}

#[tokio::test]
async fn a_relaunch_mid_note_leaves_no_partial_rows_and_the_next_object_finishes_the_note() {
    let mut s = setup().await;
    s.write("long", "Long", &long_body());
    assert!(matches!(
        s.step().await,
        StepOutcome::Embedded { embedded: 0, .. }
    ));
    assert_eq!(
        s.window_rows("long"),
        0,
        "one window of several writes nothing"
    );
    assert!(s.states().is_empty());

    s.relaunch();
    s.finish().await;
    let state = &s.states()[0];
    assert!(state.window_count >= 2);
    assert_eq!(s.window_rows("long"), state.window_count);
}

#[tokio::test]
async fn an_edit_mid_note_commits_what_was_embedded_and_requeues_the_note() {
    let s = setup().await;
    s.write("long", "Long", &long_body());
    let written = s.source_key_of("long");
    s.step().await;
    s.edit_body("long", 2, "appended while the note was in flight");
    let edited = s.source_key_of("long");
    assert_ne!(written, edited);

    let first = loop {
        s.step().await;
        if let Some(state) = s.states().pop() {
            break state;
        }
    };
    assert_ne!(
        first.source_key, edited,
        "the commit names the text it was built from"
    );
    s.finish().await;
    assert_eq!(s.states()[0].source_key, edited);
}

#[tokio::test]
async fn a_deleted_note_is_pruned() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    s.write("b", "Beta", "the second note body");
    s.finish().await;
    s.with_data(|conn| {
        notes::delete(conn, "a", DEVICE, NOW).unwrap();
    });
    assert_eq!(s.finish().await, (1, 1));
    let ids: Vec<String> = s.states().into_iter().map(|state| state.note_id).collect();
    assert_eq!(ids, ["b"]);
    assert_eq!(s.window_rows("a"), 0);
}

#[tokio::test]
async fn critical_stops_before_work_and_serious_rests() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    let hot = |thermal| StepConditions {
        thermal,
        external_power: true,
    };
    let stop = s
        .semantic
        .embed_step(s.vault.clone(), hot(Thermal::Critical))
        .await
        .unwrap();
    assert_eq!(stop, stopped(StepStop::TooHot));
    assert_eq!(s.loads.load(Ordering::SeqCst), 0, "no model loaded");

    let rest = s
        .semantic
        .embed_step(s.vault.clone(), hot(Thermal::Serious))
        .await
        .unwrap();
    assert!(matches!(rest, StepOutcome::Embedded { rest_ms, .. } if rest_ms > 0));
}

#[tokio::test]
async fn on_battery_stops() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    let battery = StepConditions {
        thermal: Thermal::Nominal,
        external_power: false,
    };
    let stop = s
        .semantic
        .embed_step(s.vault.clone(), battery)
        .await
        .unwrap();
    assert_eq!(stop, stopped(StepStop::OnBattery));
    assert!(s.states().is_empty());
}

#[tokio::test]
async fn a_memory_warning_unloads_and_stops_the_next_step_once() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    s.write("b", "Beta", "the second note body");
    s.step().await;
    s.semantic.release(ReleaseReason::MemoryWarning);
    assert_eq!(s.step().await, stopped(StepStop::MemoryPressure));
    s.finish().await;
    assert_eq!(
        s.loads.load(Ordering::SeqCst),
        2,
        "the warning unloaded the model"
    );
}

#[tokio::test]
async fn a_background_release_unloads_only_while_no_step_holds_the_model() {
    let mut s = setup().await;
    let (open, gate) = channel();
    let (entered, inside) = channel();
    s.semantic = s.build(Some((Arc::new(Mutex::new(gate)), entered)));
    let s = Arc::new(s);
    s.write("a", "Alpha", "the first note body");
    s.write("b", "Beta", "the second note body");
    s.write("c", "Gamma", "the third note body");

    let running = tokio::spawn({
        let s = s.clone();
        async move { s.step().await }
    });
    tokio::task::spawn_blocking(move || inside.recv().unwrap())
        .await
        .unwrap();
    s.semantic.release(ReleaseReason::Background);
    open.send(()).unwrap();
    running.await.unwrap();

    open.send(()).unwrap();
    s.step().await;
    assert_eq!(
        s.loads.load(Ordering::SeqCst),
        1,
        "the lease kept the model"
    );

    s.semantic.release(ReleaseReason::Background);
    open.send(()).unwrap();
    s.step().await;
    assert_eq!(
        s.loads.load(Ordering::SeqCst),
        2,
        "an idle release unloaded it"
    );
}

#[tokio::test]
async fn opted_out_the_step_stops_and_writes_nothing() {
    let s = setup().await;
    s.write("a", "Alpha", "the first note body");
    s.semantic.disable(s.vault.clone()).await.unwrap();
    assert_eq!(s.step().await, stopped(StepStop::ModelNotReady));
    assert!(!s.vault.directory().join("vectors.db").exists());
}
