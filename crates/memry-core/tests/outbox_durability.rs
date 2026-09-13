//! Outbox durability against a real `rusqlite` database on disk (T132,
//! FR-030, Constitution III, data-model §A.2 and §C.4).
//!
//! `outbox` is the one table whose loss loses a user's work, and §C.4 states
//! the rule as **durable before acknowledged**. Three things have to be true
//! for that sentence to mean anything, and each is a test below:
//!
//! | Test                        | What it pins                                     |
//! | --------------------------- | ------------------------------------------------ |
//! | the call log                | source row, then outbox row, then `COMMIT`, then the acknowledgement |
//! | a refused store             | neither half survives and nothing is acknowledged |
//! | a process death             | the batch is fully present or never acknowledged  |
//!
//! **Nothing here fakes the store.** The call log is SQLite's own
//! `sqlite3_trace` output, so the order asserted is the order the engine
//! executed rather than the order this file recorded; the refusal is a
//! `RAISE(ABORT)` inside the database, which is the shape a constraint, a
//! disk error or a corrupt page takes on the way out; and the process death
//! is a real child process holding a real open transaction, killed with
//! SIGKILL so no destructor, no unwind and no `COMMIT` can run.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Change};
use rusqlite::trace::{TraceEvent, TraceEventCodes};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A scratch directory. Left for the OS to reap: the process-death test needs
/// the file to outlive a child process, so nothing here may be removed on
/// drop.
fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-durability-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    dir
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn new_note(id: &str) -> NewNote<'_> {
    NewNote {
        id,
        title: "A note",
        folder_path: Some("Notes"),
        content: "",
        tags: &[],
        properties: None,
    }
}

fn count(db: &Db, sql: &str, id: &str) -> i64 {
    let sql = sql.to_owned();
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        conn.query_row(&sql, [&id], |row| row.get(0))
            .map_err(failed)
    })
    .expect("count")
}

fn source_rows(db: &Db, id: &str) -> i64 {
    count(db, "SELECT count(*) FROM sync_items WHERE item_id = ?1", id)
}

fn projected_rows(db: &Db, id: &str) -> i64 {
    count(db, "SELECT count(*) FROM notes WHERE id = ?1", id)
}

fn queued_rows(db: &Db, id: &str) -> i64 {
    count(db, "SELECT count(*) FROM outbox WHERE item_id = ?1", id)
}

fn outbox_ids(db: &Db) -> Vec<i64> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT id FROM outbox ORDER BY id")
            .map_err(failed)?;
        let ids = statement
            .query_map([], |row| row.get(0))
            .and_then(Iterator::collect::<Result<Vec<i64>, _>>)
            .map_err(failed)?;
        Ok(ids)
    })
    .expect("read the outbox")
}

// ------------------------------------------------------------ the call log

/// SQLite's own statement log. A `fn` pointer is all `Connection::trace`
/// takes, so the sink is a static and one test holds [`TRACE_GATE`] for its
/// duration.
static TRACE_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static TRACE_GATE: Mutex<()> = Mutex::new(());

fn record(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, statement) = event {
        TRACE_LOG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(statement.to_owned());
    }
}

/// The order is asserted against **what SQLite executed**, not against
/// bookkeeping this test kept alongside it (T132's "order against a call
/// log").
///
/// Driven through the real `notes::create`, so what is pinned is the order the
/// production path takes: §C.4's "durable before acknowledged" is a claim
/// about the sequence `BEGIN`, source row, outbox row, `COMMIT`,
/// acknowledgement, and every one of those five appears in the log below.
///
/// The acknowledgement marks itself in the same log — a `SELECT` run
/// immediately after [`Durable::acknowledge`] — so its position is measured on
/// SQLite's clock rather than on this file's.
#[test]
fn the_call_log_puts_the_source_row_the_outbox_row_and_the_commit_before_the_acknowledgement() {
    let _gate = TRACE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    TRACE_LOG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();

    let dir = scratch_dir("call-log");
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        // Installed after the migrations, so the log carries this batch only.
        conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(record));
        Ok(())
    })
    .expect("install the trace");

    let durable = db
        .call_blocking(|conn| notes::create(conn, &new_note("callloggednote"), DEVICE, NOW))
        .expect("the create commits");

    db.call_blocking(|conn| {
        let _note_id = durable.acknowledge();
        conn.execute_batch("SELECT 'the acknowledgement'")
            .map_err(failed)
    })
    .expect("mark the acknowledgement");

    db.call_blocking(|conn| {
        conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, None);
        Ok(())
    })
    .expect("remove the trace");

    let log = TRACE_LOG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let at = |needle: &str| {
        log.iter()
            .position(|statement| statement.contains(needle))
            .unwrap_or_else(|| panic!("no statement containing `{needle}` in {log:#?}"))
    };

    let begin = at("BEGIN");
    let source = at("INSERT INTO sync_items");
    let queued = at("INSERT INTO outbox");
    let commit = at("COMMIT");
    let acknowledged = at("the acknowledgement");

    assert!(
        begin < source,
        "the source row is written inside a transaction, not before one: {log:#?}"
    );
    assert!(
        source < queued,
        "§A.2: the source row is written first, so a failing source write leaves no outbox row: {log:#?}"
    );
    assert!(
        queued < commit,
        "both halves are inside the same transaction: {log:#?}"
    );
    assert!(
        commit < acknowledged,
        "§C.4: the acknowledgement is minted only after COMMIT returned: {log:#?}"
    );

    // One transaction, not two. Two would mean one half could commit alone.
    assert_eq!(
        log.iter().filter(|s| s.contains("BEGIN")).count(),
        1,
        "the batch opened more than one transaction: {log:#?}"
    );
    assert_eq!(
        log.iter().filter(|s| s.contains("COMMIT")).count(),
        1,
        "the batch committed more than once: {log:#?}"
    );
}

// --------------------------------------------------------- a refused store

/// **A refused store acknowledges nothing** (T132), where the store is the one
/// refusing rather than the caller.
///
/// `tests/sync_outbox.rs` already covers a source write that returns `Err`.
/// This is the other half and the harder one: the source write succeeds and
/// the **outbox insert** is refused, which is the moment at which a queue that
/// acknowledged optimistically would have already told the user their note was
/// saved. The refusal is a `RAISE(ABORT)` inside SQLite, so it arrives the way
/// a constraint, a full disk or a corrupt page arrives — through the same
/// `rusqlite::Error` path, not through a seam this test controls.
#[test]
fn a_store_that_refuses_the_outbox_row_keeps_neither_half_and_acknowledges_nothing() {
    let dir = scratch_dir("refused-store");
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER refuse_the_outbox BEFORE INSERT ON outbox
             BEGIN SELECT RAISE(ABORT, 'the store refused the outbox row'); END",
        )
        .map_err(failed)
    })
    .expect("arm the refusal");

    // There is no `Durable` on this branch at all: `Result::Err` carries no
    // value, and `Durable`'s only constructor runs after `COMMIT` returned.
    let error = db
        .call_blocking(|conn| notes::create(conn, &new_note("refusednote"), DEVICE, NOW))
        .expect_err("a refused outbox row must fail the whole create");
    assert!(
        error
            .to_string()
            .contains("the store refused the outbox row"),
        "the refusal reached the caller unchanged: {error}"
    );

    assert_eq!(
        source_rows(&db, "refusednote"),
        0,
        "FR-030: the source row rolled back with the outbox row it could not be published by"
    );
    assert_eq!(
        projected_rows(&db, "refusednote"),
        0,
        "and so did its projection"
    );
    assert_eq!(outbox_ids(&db), Vec::<i64>::new());

    // The refusal was the store's, not something about this note: the same
    // create lands once the trigger is gone, and it lands whole.
    db.call_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER refuse_the_outbox")
            .map_err(failed)
    })
    .expect("disarm the refusal");

    let durable = db
        .call_blocking(|conn| notes::create(conn, &new_note("refusednote"), DEVICE, NOW))
        .expect("the same create succeeds once the store stops refusing");
    assert_eq!(
        outbox_ids(&db),
        vec![durable.outbox_id()],
        "the refused attempt left no row behind for this one to sit after"
    );
    assert_eq!(source_rows(&db, "refusednote"), 1);
    assert_eq!(projected_rows(&db, "refusednote"), 1);
}

// -------------------------------------------------------- a process death

const DEATH_DB: &str = "MEMRY_OUTBOX_DURABILITY_DEATH_DB";
const DEATH_MARKER: &str = "MEMRY_OUTBOX_DURABILITY_DEATH_MARKER";
const COMMITTED_NOTE: &str = "committednote";
const UNCOMMITTED_NOTE: &str = "uncommittednote";

/// The other half of this test, run in a **separate process** that is killed
/// rather than allowed to finish.
///
/// `#[ignore]` keeps it out of the ordinary run; the parent re-invokes this
/// binary with `--ignored --exact`. Without the environment the parent sets it
/// is a no-op, so `cargo test -- --ignored` by hand cannot hang on it.
#[test]
#[ignore = "spawned as a child by a_process_death_leaves_the_batch_fully_present_or_never_acknowledged"]
fn child_holds_an_uncommitted_batch_until_it_is_killed() {
    let Ok(path) = std::env::var(DEATH_DB) else {
        return;
    };
    let marker = std::env::var(DEATH_MARKER).expect("the parent sets both variables or neither");
    let db = open_data(Path::new(&path)).expect("the child opens data.db");

    // Batch one: the whole of `outbox::commit`, `COMMIT` included. Never
    // acknowledged — the child is killed before it could be.
    db.call_blocking(|conn| notes::create(conn, &new_note(COMMITTED_NOTE), DEVICE, NOW))
        .expect("the committed batch");

    // Batch two: both halves written, `COMMIT` deliberately never run. The
    // transaction is opened as raw SQL rather than through
    // `Connection::unchecked_transaction` because a `Transaction` guard rolls
    // back when it drops, and the point of this child is that nothing gets to
    // run at the end.
    db.call_blocking(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE").map_err(failed)?;
        sync_items::upsert_metadata_only(conn, notes::ITEM_TYPE, UNCOMMITTED_NOTE, NOW, Some(7))?;
        outbox::enqueue(
            conn,
            &Change::upsert(notes::ITEM_TYPE, UNCOMMITTED_NOTE),
            NOW,
        )?;
        Ok(())
    })
    .expect("the open batch");

    std::fs::write(
        &marker,
        b"both halves are written and the COMMIT has not run",
    )
    .expect("signal the parent");

    // The parent kills this process here. Sleeping rather than looping so a
    // leaked child costs nothing; the parent's deadline is the real bound.
    std::thread::sleep(Duration::from_secs(120));
}

/// **A simulated process death leaves the batch either fully present or never
/// acknowledged** (T132, FR-030).
///
/// The simulation is a real one, and that is the point. A child process opens
/// the same `data.db`, commits one batch, leaves a second batch's two halves
/// written inside an open transaction, and is then killed with `SIGKILL` —
/// uncatchable, so no `Drop`, no unwind, no `atexit`, no rollback issued by
/// this program and no `COMMIT`. What the parent reads afterwards is what
/// SQLite's own WAL recovery decided, from the same file, in a fresh process:
/// exactly what the next launch of the app sees after the OS kills it.
///
/// The two notes carry the two legal outcomes:
///
/// - `COMMITTED_NOTE` is **fully present** — source row, projection and outbox
///   row — and was never acknowledged, so the next wave re-sends it;
/// - `UNCOMMITTED_NOTE` is **entirely absent**, both halves, so nothing was
///   half-written and nothing was acknowledged.
///
/// A durability bug shows up here as a third outcome: one half of a batch
/// without the other.
#[test]
fn a_process_death_leaves_the_batch_fully_present_or_never_acknowledged() {
    let dir = scratch_dir("process-death");
    let path = dir.join("data.db");
    let marker = dir.join("ready");

    let mut child = Command::new(std::env::current_exe().expect("this test binary"))
        .args([
            "--exact",
            "child_holds_an_uncommitted_batch_until_it_is_killed",
            "--ignored",
            "--test-threads",
            "1",
        ])
        .env(DEATH_DB, &path)
        .env(DEATH_MARKER, &marker)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the child");

    let deadline = Instant::now() + Duration::from_secs(90);
    while !marker.exists() {
        assert!(
            child.try_wait().expect("poll the child").is_none(),
            "the child exited instead of holding the transaction open"
        );
        assert!(
            Instant::now() < deadline,
            "the child never reached the open transaction"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    child.kill().expect("kill the child");
    let status = child.wait().expect("reap the child");
    assert!(
        !status.success(),
        "the child must die mid-transaction rather than finish: {status}"
    );

    // A fresh process, the same file: this is the next launch.
    let db = open_data(&path).expect("reopen data.db after the death");

    assert_eq!(
        source_rows(&db, COMMITTED_NOTE),
        1,
        "the committed batch's source row survived the kill"
    );
    assert_eq!(
        projected_rows(&db, COMMITTED_NOTE),
        1,
        "and so did its projection"
    );
    assert_eq!(
        queued_rows(&db, COMMITTED_NOTE),
        1,
        "and its outbox row, because the acknowledgement never happened"
    );

    assert_eq!(
        source_rows(&db, UNCOMMITTED_NOTE),
        0,
        "the open batch's source row did not survive without its outbox row"
    );
    assert_eq!(
        queued_rows(&db, UNCOMMITTED_NOTE),
        0,
        "and its outbox row did not survive without its source row"
    );

    // No third outcome: one batch, whole, and nothing else.
    assert_eq!(
        outbox_ids(&db).len(),
        1,
        "a half-written batch would show up as an extra row here"
    );

    // Recovered and claimable, with no backoff invented by the crash: the
    // wave that runs on the next launch re-sends the committed change at once.
    let pending = db
        .call_blocking(|conn| outbox::pending(conn, NOW))
        .expect("count the claimable rows");
    assert_eq!(pending, 1);
    let attempts: i64 = db
        .call_blocking(|conn| {
            conn.query_row("SELECT attempt_count FROM outbox", [], |row| row.get(0))
                .map_err(failed)
        })
        .expect("read attempt_count");
    assert_eq!(attempts, 0, "a process death is not a failed attempt");
}
