//! Reads do not wait behind a sync write (Tauri epic Step 08).
//!
//! A sync pass holds the writer for the length of its transaction. Before the
//! read pool, every list the UI asked for queued on the writer's mutex behind
//! it. This seeds a real vault, holds a write transaction over 50000
//! `sync_items` rows on the writer, and runs reads through the public API
//! while it is held. No assertion measures latency: the writer stays inside its
//! transaction until the reads have finished, so a read that waited for the
//! writer never finishes, and a liveness guard fails the test with a message.
//! The p50/p99 numbers live in an `#[ignore]`d release-build test that reports
//! a miss and fails only under `MEMRY_PERF_ENFORCE=1`.
//!
//! | Test                                              | Rule                                      |
//! | ------------------------------------------------- | ----------------------------------------- |
//! | pooled reads finish under a held write            | every read returns while the writer is    |
//! |                                                   | held (liveness guard, 120 s)              |
//! | the same reads through the writer wait for it     | control: a writer-routed call runs after  |
//! |                                                   | the held transaction's closure ends       |
//! | a reader never sees the uncommitted rows          | snapshot isolation under WAL              |
//!
mod http_fakes;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
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
const READS: usize = 300;

/// The tests take turns: one test holds the writer while its neighbours seed.
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
    let dir = tempfile::Builder::new()
        .prefix("memry-read-pool-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
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

/// Order in which the held transaction and the readers finish.
static CLOCK: AtomicUsize = AtomicUsize::new(0);

fn tick() -> usize {
    CLOCK.fetch_add(1, Ordering::SeqCst)
}

/// Holds the writer inside `BEGIN IMMEDIATE` after inserting `SYNC_ROWS` rows,
/// as a sync pull applying a large page of records does, until `release`
/// fires. The first receiver fires once the transaction is open; the join
/// handle yields the tick taken just before COMMIT.
fn hold_writer(
    db: Db,
    release: mpsc::Receiver<()>,
) -> (mpsc::Receiver<()>, std::thread::JoinHandle<usize>) {
    let (started_tx, started_rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        db.call_blocking(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE").map_err(failed)?;
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
            started_tx.send(()).expect("signal");
            release.recv().expect("the release signal");
            let committed = tick();
            conn.execute_batch("COMMIT").map_err(failed)?;
            Ok(committed)
        })
        .expect("the held write")
    });
    (started_rx, handle)
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

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    let rank = ((sorted.len() as f64) * p).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// How long the reads may take before the test calls them blocked. A liveness
/// guard, not a latency bound: reads that wait for the writer never finish, so
/// any value far above a run's real duration tells them apart.
const LIVENESS: Duration = Duration::from_secs(120);

#[test]
fn pooled_reads_finish_while_the_writer_holds_a_sync_transaction() {
    let _turn = one_at_a_time();
    let s = seeded(NOTES, TASKS);
    let read = api_reads(&s);
    warm_up(&read);

    let (release_tx, release_rx) = mpsc::channel();
    let (started, writer) = hold_writer(s.vault.db_handle(), release_rx);
    started.recv().expect("the writer holds its transaction");
    let (done_tx, done_rx) = mpsc::channel();
    let finished = std::thread::scope(|scope| {
        scope.spawn(|| {
            for i in 0..READS {
                read(i);
            }
            let _ = done_tx.send(());
        });
        // The writer is still inside its transaction while this waits.
        let finished = done_rx.recv_timeout(LIVENESS).is_ok();
        // Release either way, so a blocked reader can end and the scope can join.
        release_tx.send(()).expect("release the writer");
        finished
    });
    writer.join().expect("the writer thread");
    assert!(
        finished,
        "the reads were still blocked after {LIVENESS:?} with the writer held: they waited for it"
    );
}

/// Latency of the pooled reads under the held write. Release builds only, and
/// a miss is reported, not failed, unless `MEMRY_PERF_ENFORCE=1` (as in
/// markdown_perf): `cargo test --release --test read_pool_contention
/// pooled_read_latency -- --ignored --nocapture`.
#[test]
#[ignore = "timing: run in a release build, see the doc comment"]
fn pooled_read_latency_under_a_held_write() {
    let _turn = one_at_a_time();
    let s = seeded(NOTES, TASKS);
    let read = api_reads(&s);
    warm_up(&read);
    let (release_tx, release_rx) = mpsc::channel();
    let (started, writer) = hold_writer(s.vault.db_handle(), release_rx);
    started.recv().expect("the writer holds its transaction");
    let mut latencies: Vec<Duration> = (0..READS)
        .map(|i| {
            let began = Instant::now();
            read(i);
            began.elapsed()
        })
        .collect();
    release_tx.send(()).expect("release the writer");
    writer.join().expect("the writer thread");
    latencies.sort();
    let (p50, p99, max) = (
        percentile(&latencies, 0.50),
        percentile(&latencies, 0.99),
        *latencies.last().expect("latencies"),
    );
    println!("pooled reads while the writer is held: p50 {p50:?} p99 {p99:?} max {max:?}");
    let missed = p50 >= Duration::from_millis(2)
        || p99 >= Duration::from_millis(20)
        || max >= Duration::from_millis(50);
    if std::env::var("MEMRY_PERF_ENFORCE").is_ok_and(|v| v == "1") {
        assert!(!missed, "p50 {p50:?} p99 {p99:?} max {max:?}");
    } else if missed {
        println!("over budget (not enforced)");
    }
}

#[test]
fn the_same_reads_through_the_writer_wait_for_the_held_transaction() {
    let _turn = one_at_a_time();
    let s = seeded(50, 0);
    let db = s.vault.db_handle();
    let (release_tx, release_rx) = mpsc::channel();
    let (started, writer) = hold_writer(db.clone(), release_rx);
    started.recv().expect("the writer holds its transaction");

    let id = s.note_ids[0].clone();
    let control = std::thread::spawn(move || {
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
        tick()
    });
    release_tx.send(()).expect("release the writer");
    let committed = writer.join().expect("the writer thread");
    let served = control.join().expect("the control read");

    assert!(
        served > committed,
        "the control ran at {served}, before the commit at {committed}: the writer was not held"
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

    let (release_tx, release_rx) = mpsc::channel();
    let (started, writer) = hold_writer(db.clone(), release_rx);
    started.recv().expect("the writer holds its transaction");
    let during = count(&db);
    release_tx.send(()).expect("release the writer");
    writer.join().expect("the writer thread");
    let after = count(&db);

    assert_eq!(during, before, "an uncommitted row leaked into a reader");
    assert_eq!(
        after,
        before + SYNC_ROWS as i64,
        "the commit became visible"
    );
}
