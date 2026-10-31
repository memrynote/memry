//! The note index (Step 13e) at scale, over a real session, tier and watcher: a generated vault
//! of 1000 notes is measured into `note_stats` once per note, and a reindex reports throttled,
//! monotonic progress ending at the total, in one `index.db` statement per note. A close ends a
//! reindex and the vault opens again.
//!
//! The times print with `--nocapture`; no normal test asserts one. The budgets of #3530 (tier 0
//! under 400 ms, `notes_list` under 15 ms) are asserted by the ignored release run:
//!
//! ```text
//! cargo test -p memry-desktop --release --test indexer_scan -- --ignored --nocapture
//! ```

mod device_key;
mod index_support;
mod vault_env;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use index_support::{all_indexed, note_text, seeded, until};
use memry_core::domain::note_stats::measure;
use memry_desktop::notes::index::{
    Backfilled, IndexError, IndexProgress, NoteIndex, PROGRESS_INTERVAL,
};
use memry_desktop::vault::hash::content_hash;
use rusqlite::trace::TraceEventCodes;
use vault_env::{Env, indexed};

const NOTES: usize = 1000;

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);

struct Measured {
    tier0: Duration,
    tier1: Duration,
    notes_list: Duration,
}

/// Opens the seeded vault with the index and times the open walk (tier 0), the backfill
/// (tier 1) and the sidebar list.
fn open_and_measure(e: &mut Env) -> (Arc<NoteIndex>, Measured) {
    let index = NoteIndex::new(e.tier.clone());
    index.register(&e.session);
    e.drain();
    let started = Instant::now();
    e.open();
    e.facts_until(indexed);
    let tier0 = started.elapsed();
    until("every note measured", || all_indexed(e));
    let tier1 = started.elapsed();
    let listed_at = Instant::now();
    let listed = e.core().notes().list().unwrap();
    let notes_list = listed_at.elapsed();
    assert_eq!(listed.len(), NOTES);
    println!(
        "{NOTES} notes: tier 0 {tier0:?}, tier 1 {tier1:?}, notes_list {notes_list:?} ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    let measured = Measured {
        tier0,
        tier1,
        notes_list,
    };
    (index, measured)
}

/// Counts the statements the index writer runs until the next call.
fn count_index_statements(e: &Env, on: bool) -> usize {
    let index = e.session.current().unwrap().search.index_handle();
    index
        .call_blocking(|conn| {
            if on {
                STATEMENTS.store(0, Ordering::SeqCst);
                conn.trace_v2(
                    TraceEventCodes::SQLITE_TRACE_STMT,
                    Some(|_| {
                        STATEMENTS.fetch_add(1, Ordering::SeqCst);
                    }),
                );
            } else {
                conn.trace_v2(TraceEventCodes::empty(), None);
            }
            Ok(STATEMENTS.load(Ordering::SeqCst))
        })
        .unwrap()
}

#[test]
fn a_generated_vault_is_measured_once_per_note_and_a_reindex_reports_to_the_total() {
    let (mut e, _store, notes) = seeded(NOTES);
    let (index, _) = open_and_measure(&mut e);

    let search = e.session.current().unwrap().search;
    for (i, (id, _)) in notes.iter().enumerate() {
        let stored = search.note_stats(id).unwrap().expect("a row");
        assert_eq!(stored.stats, measure(&note_text(i)), "{id}");
        assert_eq!(stored.file_hash, Some(content_hash(&note_text(i))));
        assert_eq!(stored.date, None);
    }

    let steps: Arc<Mutex<Vec<(Instant, IndexProgress)>>> = Arc::default();
    let seen = steps.clone();
    count_index_statements(&e, true);
    let done = index
        .reindex(move |step| seen.lock().unwrap().push((Instant::now(), step)))
        .unwrap();
    let statements = count_index_statements(&e, false);
    assert_eq!(
        done,
        Backfilled {
            listed: NOTES,
            indexed: NOTES,
            skipped: 0,
            unread: 0,
        }
    );
    // One insert per note, then the batches' transactions, the prune and a search reindex
    // that finds nothing moved: never a statement per note beyond its row.
    println!("reindex of {NOTES} notes: {statements} index.db statements");
    assert!(
        (NOTES..NOTES + 60).contains(&statements),
        "{statements} statements"
    );

    let steps = steps.lock().unwrap().clone();
    let progress: Vec<IndexProgress> = steps.iter().map(|(_, step)| *step).collect();
    let step = |built| IndexProgress {
        built,
        total: NOTES,
    };
    assert_eq!(progress.first(), Some(&step(0)));
    assert_eq!(progress.last(), Some(&step(NOTES)));
    assert!(
        progress.windows(2).all(|w| w[0].built < w[1].built),
        "{progress:?}"
    );
    // Throttled: every step but the last came at least an interval after the one before
    // (less a margin for the callback running after the throttle's clock read).
    let throttled = PROGRESS_INTERVAL - Duration::from_millis(10);
    let gaps: Vec<Duration> = steps[..steps.len() - 1]
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .collect();
    assert!(gaps.iter().all(|gap| *gap >= throttled), "{gaps:?}");
    e.close();
}

/// Runs a reindex, holds its task at the first step `at` names, calls `held`, then closes the
/// vault: the reindex answers that the vault is gone, and so does the next one.
fn close_inside_a_reindex(
    e: &mut Env,
    index: &Arc<NoteIndex>,
    at: fn(IndexProgress) -> bool,
    held: impl FnOnce(&Env),
) {
    let (started, first) = mpsc::channel();
    let session = e.session.clone();
    let asked = index.clone();
    let reindex = std::thread::spawn(move || {
        asked.reindex(move |step| {
            if at(step) {
                let _ = started.send(());
                // Progress runs on the task's thread: the task waits here until the close began.
                until("the close to begin", || session.current().is_none());
            }
        })
    });
    first.recv().unwrap();
    held(e);
    e.close();
    let result = reindex.join().unwrap();
    assert!(matches!(result, Err(IndexError::NotOpen)), "{result:?}");
    assert!(matches!(index.reindex(|_| {}), Err(IndexError::NotOpen)));
}

fn index_meta_rows(e: &Env) -> i64 {
    let index = rusqlite::Connection::open(e.vault.join(".memry/core/index.db")).unwrap();
    index.busy_timeout(Duration::from_secs(5)).unwrap();
    index
        .query_row("SELECT count(*) FROM index_meta", [], |row| row.get(0))
        .unwrap()
}

/// A close stops a reindex between two files, and inside its search reindex, which then
/// commits nothing; the vault opens again each time: nothing of the index outlives the close.
#[test]
fn a_close_ends_a_reindex_and_the_vault_opens_again() {
    let (mut e, _store, _) = seeded(NOTES);
    let index = NoteIndex::new(e.tier.clone());
    assert!(matches!(index.reindex(|_| {}), Err(IndexError::NotOpen)));
    index.register(&e.session);
    e.open();
    until("every note measured", || all_indexed(&e));

    close_inside_a_reindex(&mut e, &index, |step| step.built == 0, |_| {});

    // Every file read, the search reindex next. Without its watermarks the search index owes a
    // full rebuild of every note, which the close stops before it commits.
    e.open();
    close_inside_a_reindex(
        &mut e,
        &index,
        |step| step.total > 0 && step.built == step.total,
        |e| {
            rusqlite::Connection::open(e.vault.join(".memry/core/index.db"))
                .unwrap()
                .execute("DELETE FROM index_meta", [])
                .unwrap();
        },
    );
    assert_eq!(
        index_meta_rows(&e),
        0,
        "the stopped search reindex committed"
    );

    e.open();
    let done = index.reindex(|_| {}).unwrap();
    assert_eq!(done.indexed, NOTES);
    assert!(
        index_meta_rows(&e) > 0,
        "the next reindex rebuilt the search index"
    );
    // Closed again with its task idle: the close wakes it, and the vault opens again.
    e.close();
    e.open();
    e.close();
}

/// The #3530 budgets, in a release build: `cargo test --release ... -- --ignored`.
#[test]
#[ignore = "a release-build measurement"]
fn the_open_walk_and_the_sidebar_list_meet_their_budgets() {
    let (mut e, _store, _) = seeded(NOTES);
    let (_, measured) = open_and_measure(&mut e);
    // timing-bound: the #3530 budget, asserted only by this ignored release-build run.
    assert!(
        measured.tier0 < Duration::from_millis(400),
        "{:?}",
        measured.tier0
    );
    // timing-bound: the #3530 budget, asserted only by this ignored release-build run.
    assert!(
        measured.notes_list < Duration::from_millis(15),
        "{:?}",
        measured.notes_list
    );
    println!("tier 1 took {:?}", measured.tier1);
    e.close();
}
