//! Reads do not wait behind a sync write (Tauri epic Step 08).
//!
//! A sync pass holds the writer for the length of its transaction. Before the
//! read pool, every list the UI asked for queued on the writer's mutex behind
//! it. This seeds a real vault, holds a 2 s write transaction over 50000
//! `sync_items` rows on the writer, and times reads through the public API
//! while it is held.
//!
//! | Test                                              | Rule                                      |
//! | ------------------------------------------------- | ----------------------------------------- |
//! | pooled reads stay fast under a held write         | p50 < 2 ms, p99 < 20 ms, max < 50 ms      |
//! | the same reads through the writer wait for it     | control: max >= 1500 ms, so a regression  |
//! |                                                   | to the writer would fail the test above   |
//! | a reader never sees the uncommitted rows          | snapshot isolation under WAL              |
//!
//! The latency assertions run in release only (`cargo test --release`); a debug
//! build runs the same flow on a smaller vault and asserts correctness alone.

mod http_fakes;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use http_fakes::FakeSecureStore;
use memry_core::api::errors::StorageError;
use memry_core::api::notes::Notes;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::search::Search;
use memry_core::api::tasks::Tasks;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::Db;

const RELEASE: bool = !cfg!(debug_assertions);
const NOTES: usize = if RELEASE { 5_000 } else { 200 };
const TASKS: usize = if RELEASE { 2_000 } else { 100 };
const SYNC_ROWS: usize = if RELEASE { 50_000 } else { 2_000 };
const HOLD: Duration = Duration::from_millis(2_000);
const READS: usize = 300;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// The tests take turns: a neighbour seeding 5000 notes would load the CPU the
/// latency test is timing.
static SERIAL: Mutex<()> = Mutex::new(());

fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Seeded {
    _dir: std::path::PathBuf,
    vault: Vault,
    notes: Arc<Notes>,
    tasks: Arc<Tasks>,
    search: Arc<Search>,
    note_ids: Vec<String>,
    task_ids: Vec<String>,
}

/// A file-backed vault filled through the same write APIs the app uses.
fn seeded(note_count: usize, task_count: usize) -> Seeded {
    // One directory per test: the three run in parallel in one process.
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-read-pool-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");

    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let writer = vault.notes_writer(store.clone()).expect("the note writer");
    let note_ids: Vec<String> = (0..note_count)
        .map(|i| {
            writer
                .create(format!("Quarterly planning notes {i}"), None)
                .expect("create a note")
        })
        .collect();

    let tasks = vault.tasks(store).expect("the task surface");
    let project = tasks
        .create_project(ProjectDraft {
            name: "Benchmark".to_owned(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("create a project");
    let task_ids: Vec<String> = (0..task_count)
        .map(|i| {
            tasks
                .create(NewTaskInput {
                    title: format!("Quarterly planning task {i}"),
                    project_id: project.clone(),
                    status_id: None,
                    parent_id: None,
                    priority: 0,
                    description: None,
                    due_date: None,
                    due_time: None,
                    start_date: None,
                    repeat: None,
                    repeat_from: None,
                    tags: Vec::new(),
                    linked_note_ids: Vec::new(),
                    linked_canvas_ids: Vec::new(),
                    source_note_id: None,
                    position: None,
                })
                .expect("create a task")
                .created[0]
                .clone()
        })
        .collect();

    let search = vault.search().expect("the search surface");
    search.reindex().expect("index the vault");
    let notes = vault.notes();
    Seeded {
        _dir: dir,
        vault,
        notes,
        tasks,
        search,
        note_ids,
        task_ids,
    }
}

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// Holds the writer inside `BEGIN IMMEDIATE` for [`HOLD`] after inserting
/// `SYNC_ROWS` rows, as a sync pull applying a large page of records does. The
/// receiver fires once the transaction is open.
fn hold_writer(db: Db) -> (mpsc::Receiver<()>, std::thread::JoinHandle<()>) {
    let (started_tx, started_rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        db.call_blocking(|conn| {
            let begun = Instant::now();
            conn.execute_batch("BEGIN IMMEDIATE").map_err(failed)?;
            started_tx.send(()).expect("signal");
            let mut put = conn
                .prepare(
                    "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                     VALUES ('note', ?1, '{}', 'full', 1)",
                )
                .map_err(failed)?;
            for i in 0..SYNC_ROWS {
                put.execute([format!("bulk-{i}")]).map_err(failed)?;
            }
            drop(put);
            if let Some(left) = HOLD.checked_sub(begun.elapsed()) {
                std::thread::sleep(left);
            }
            conn.execute_batch("COMMIT").map_err(failed)
        })
        .expect("the held write");
    });
    (started_rx, handle)
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    let rank = ((sorted.len() as f64) * p).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// Times `READS` calls of `read(i)` while the writer is held.
fn timed_during_hold(db: &Db, read: impl Fn(usize)) -> Vec<Duration> {
    let (started, writer) = hold_writer(db.clone());
    started.recv().expect("the writer holds its transaction");
    let latencies = (0..READS)
        .map(|i| {
            let began = Instant::now();
            read(i);
            began.elapsed()
        })
        .collect();
    writer.join().expect("the writer thread");
    latencies
}

/// The three reads the issue names, through the public API.
fn api_reads(s: &Seeded) -> impl Fn(usize) + '_ {
    move |i| match i % 3 {
        0 => {
            let id = s.note_ids[i % s.note_ids.len()].clone();
            assert!(s.notes.metadata(id).expect("note metadata").is_some());
        }
        1 => {
            let id = s.task_ids[i % s.task_ids.len()].clone();
            assert!(s.tasks.get(id).expect("a task").is_some());
        }
        _ => {
            let hits = s.search.notes("quarterly".to_owned(), 50).expect("search");
            assert!(!hits.is_empty());
        }
    }
}

fn warm_up(read: &impl Fn(usize)) {
    for i in 0..30 {
        read(i);
    }
}

#[test]
fn pooled_reads_stay_fast_while_the_writer_holds_a_sync_transaction() {
    let _turn = one_at_a_time();
    let s = seeded(NOTES, TASKS);
    let read = api_reads(&s);
    warm_up(&read);

    let mut latencies = timed_during_hold(&s.vault.db_handle(), &read);
    latencies.sort();
    let (p50, p99, max) = (
        percentile(&latencies, 0.50),
        percentile(&latencies, 0.99),
        *latencies.last().expect("latencies"),
    );
    eprintln!("pooled reads while the writer is held: p50 {p50:?} p99 {p99:?} max {max:?}");

    // The held write really was held while the reads ran.
    assert!(
        max < HOLD,
        "a pooled read took {max:?}: it waited for the writer"
    );
    if RELEASE {
        assert!(p50 < Duration::from_millis(2), "p50 {p50:?}");
        assert!(p99 < Duration::from_millis(20), "p99 {p99:?}");
        assert!(max < Duration::from_millis(50), "max {max:?}");
    }
}

#[test]
fn the_same_reads_through_the_writer_wait_for_the_held_transaction() {
    let _turn = one_at_a_time();
    let s = seeded(50, 0);
    let db = s.vault.db_handle();
    let control = |i: usize| {
        let id = s.note_ids[i % s.note_ids.len()].clone();
        let found: Option<String> = db
            .call_blocking(|conn| {
                conn.query_row("SELECT title FROM notes WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .map(Some)
                .map_err(failed)
            })
            .expect("a read through the writer");
        assert!(found.is_some());
    };

    let latencies = timed_during_hold(&db, control);
    let max = *latencies.iter().max().expect("latencies");
    eprintln!("writer-routed reads while the writer is held: max {max:?}");

    assert!(
        max >= Duration::from_millis(1_500),
        "the control did not wait ({max:?}): the benchmark could not catch a regression"
    );
}

#[test]
fn a_reader_returns_committed_rows_and_never_the_uncommitted_ones() {
    let _turn = one_at_a_time();
    let s = seeded(0, 0);
    let db = s.vault.db_handle();
    let count = |db: &Db| -> i64 {
        db.read_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM sync_items", [], |row| row.get(0))
                .map_err(failed)
        })
        .expect("count")
    };
    let before = count(&db);

    let (started, writer) = hold_writer(db.clone());
    started.recv().expect("the writer holds its transaction");
    let during = count(&db);
    writer.join().expect("the writer thread");
    let after = count(&db);

    assert_eq!(during, before, "an uncommitted row leaked into a reader");
    assert_eq!(
        after,
        before + SYNC_ROWS as i64,
        "the commit became visible"
    );
}
