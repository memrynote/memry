//! The open walk prepares its next batch of new files while it applies one (#3530 13q-7):
//! the two overlap, one batch is prepared at a time, a prepared batch is applied as soon as it
//! is ready rather than when the next one fills, every file still ends as it does alone, and a
//! close waits for the batch being prepared, so no thread outlives the consumer.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use super::flood::run;
use super::*;

/// Three batches and part of a fourth.
const FILES: usize = 3 * 128 + 20;
/// A bound for a wait that ends in milliseconds; reaching it fails the test.
const WAIT: Duration = Duration::from_secs(30);

fn with_new_files(f: &Fixture) {
    for n in 0..FILES {
        f.write(&format!("new/n{n}.md"), &format!("Note {n} text.\n"));
    }
    *f.identity.batch.lock().unwrap() = Batch::Create;
}

fn wait_for(what: &str, done: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while !done() {
        if Instant::now() > deadline {
            eprintln!("gave up waiting: {what}");
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    true
}

/// The first batch's transaction runs once the second batch is being prepared, and every file
/// gets its note together, once.
#[test]
fn the_next_batch_is_prepared_while_one_is_applied() {
    let mut f = fixture();
    with_new_files(&f);
    let identity = f.identity.clone();
    let overlapped: Arc<Mutex<Vec<bool>>> = Arc::default();
    let seen = overlapped.clone();
    let applied = Arc::new(AtomicUsize::new(0));
    let applying = applied.clone();
    *f.identity.during_adopt_new.lock().unwrap() = Some(Arc::new(move || {
        // Batch k is applied while batch k + 1 is prepared: its `may_be_new` began.
        let batch = applying.fetch_add(1, Ordering::SeqCst) + 1;
        let next = batch + 1;
        let ahead = wait_for("the next batch", || {
            identity.asked_new.load(Ordering::SeqCst) >= next.min(4)
        });
        seen.lock().unwrap().push(ahead);
    }));
    let _running = run(&f, 1 << 16);
    let mut facts = Vec::new();
    f.collect_until(&mut facts, |_, seen| {
        seen.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    assert_eq!(*overlapped.lock().unwrap(), [true; 4]);
    let created = facts
        .iter()
        .filter(|f| {
            matches!(
                f,
                Applied::Added {
                    created: true,
                    source: ChangeSource::Walk,
                    ..
                }
            )
        })
        .count();
    assert_eq!(created, FILES);
    assert!(f.adopted().is_empty(), "{:?}", f.adopted());
    for n in [0, 200, FILES - 1] {
        let row = f.row(&format!("new/n{n}.md")).expect("a row");
        assert_eq!(f.body(&row.note_id), format!("Note {n} text."));
    }
}

/// A close while a batch is being prepared returns once its thread ended: none holds the
/// vault after the consumer stopped.
#[test]
fn a_close_waits_for_the_batch_being_prepared() {
    let f = fixture();
    with_new_files(&f);
    let held_before = Arc::strong_count(&f.identity);
    // Preparing takes long enough for the close to land in it.
    *f.identity.during_may_be_new.lock().unwrap() =
        Some(Arc::new(|| std::thread::sleep(Duration::from_millis(300))));
    let mut running = run(&f, 1 << 16);
    assert!(wait_for("the second batch", || {
        f.identity.asked_new.load(Ordering::SeqCst) >= 2
    }));
    running.consumer.stop();
    assert_eq!(Arc::strong_count(&f.identity), held_before);
}

/// A full batch followed by known files edited while the app was closed: the batch's notes
/// come once it is prepared, not after every edit the rest of the walk applies.
#[test]
fn a_prepared_batch_is_applied_before_the_rest_of_the_walk() {
    const EDITED: usize = 300;
    let mut f = fixture();
    for n in 0..EDITED {
        let rel = format!("b/k{n:03}.md");
        f.write(&rel, &format!("kept {n}\n"));
        f.walked(&rel);
    }
    for n in 0..EDITED {
        f.write(
            &format!("b/k{n:03}.md"),
            &format!("kept {n} edited while closed\n"),
        );
    }
    for n in 0..128 {
        f.write(&format!("a/n{n:03}.md"), &format!("Note {n} text.\n"));
    }
    f.facts();
    *f.identity.batch.lock().unwrap() = Batch::Create;
    let _running = run(&f, 1 << 16);
    let mut facts = Vec::new();
    f.collect_until(&mut facts, |_, seen| {
        seen.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    let edit = |f: &Applied| matches!(f, Applied::Changed { path, .. } if path.starts_with("b/"));
    let first_new = facts
        .iter()
        .position(
            |f| matches!(f, Applied::Added { path, created: true, .. } if path.starts_with("a/")),
        )
        .expect("a new note");
    let edits_before = facts[..first_new].iter().filter(|f| edit(f)).count();
    assert_eq!(facts.iter().filter(|f| edit(f)).count(), EDITED);
    assert!(
        edits_before < EDITED,
        "the prepared batch waited for all {EDITED} edits"
    );
}
