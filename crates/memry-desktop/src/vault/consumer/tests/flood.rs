//! More facts than the queue holds. The queue keeps what it has, the watcher resyncs once per
//! finished pass, and the work each round costs is the work there is: files no identity adopts
//! are not reported again.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use super::*;
use crate::vault::consumer::run::{Consumer, inbox};
use crate::vault::watch::{EventSink, NewFiles, VaultWatcher};

const FILES: usize = 200;
const WAIT: Duration = Duration::from_secs(60);

struct Running {
    _watcher: VaultWatcher,
    _consumer: Consumer,
    /// `Added` events the watcher reported.
    added: Arc<AtomicUsize>,
}

fn run(f: &Fixture, capacity: usize) -> Running {
    let adopts = f.identity.adopts();
    let (sink, inbox) = inbox(capacity);
    let added = Arc::new(AtomicUsize::new(0));
    let counted: EventSink = {
        let added = added.clone();
        Arc::new(move |event| {
            if matches!(event, VaultEvent::Added { .. }) {
                added.fetch_add(1, Ordering::SeqCst);
            }
            sink(event);
        })
    };
    let new_files = if adopts {
        NewFiles::Report
    } else {
        NewFiles::PairOnly
    };
    let watcher = VaultWatcher::start(
        f.root.clone(),
        vec![],
        f.vault.note_files(),
        Arc::default(),
        counted,
        new_files,
    )
    .unwrap();
    let applier = applier(&f.root, &f.vault, &f.store, &f.rows, f.identity.clone());
    let consumer = Consumer::start(applier, inbox, watcher.handle(), vec![]).unwrap();
    Running {
        _watcher: watcher,
        _consumer: consumer,
        added,
    }
}

fn rescans(facts: &[Applied]) -> usize {
    facts
        .iter()
        .filter(|f| matches!(f, Applied::Vault(VaultEvent::Rescanned { .. })))
        .count()
}

impl Fixture {
    fn collect_until(
        &mut self,
        seen: &mut Vec<Applied>,
        done: impl Fn(&Fixture, &[Applied]) -> bool,
    ) {
        let deadline = Instant::now() + WAIT;
        while !done(self, seen) {
            assert!(Instant::now() < deadline, "still waiting: {seen:?}");
            seen.extend(self.facts());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Writes the files while the lane is held, so the consumer is stuck on the first fact and
    /// the queue overflows.
    fn flood(&self) {
        let held = self.rows.lane().unwrap();
        for n in 0..FILES {
            self.write(&format!("flood/n{n}.md"), &format!("file {n}\n"));
        }
        std::thread::sleep(Duration::from_millis(2500));
        drop(held);
    }
}

/// Nothing adopts new files: the resync after the overflow does not report them again, so
/// there is no next overflow, and no loop.
#[test]
fn a_flood_of_files_nothing_adopts_costs_one_resync_and_no_second_report() {
    let mut f = fixture();
    f.identity.adopts.store(false, Ordering::SeqCst);
    let running = run(&f, 8);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    f.flood();
    f.collect_until(&mut seen, |_, s| rescans(s) >= 2);
    let reported = running.added.load(Ordering::SeqCst);
    assert!(reported <= FILES, "a file was reported twice: {reported}");
    std::thread::sleep(Duration::from_secs(5));
    seen.extend(f.facts());
    assert_eq!(rescans(&seen), 2, "the resync repeated: {seen:?}");
    assert_eq!(running.added.load(Ordering::SeqCst), reported);
    assert!(f.adopted().is_empty());
}

/// Every file gets exactly one note although most of the facts were dropped, and the resyncs
/// that found them again are few.
#[test]
fn a_flood_of_new_files_ends_with_one_note_each() {
    let mut f = fixture();
    let _running = run(&f, 64);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    f.flood();
    f.collect_until(&mut seen, |f, _| {
        f.vault.note_files().list_paths().unwrap().len() == FILES
    });
    let mut adopted = f.adopted();
    adopted.sort();
    adopted.dedup();
    assert_eq!(adopted.len(), FILES);
    assert_eq!(f.adopted().len(), FILES, "a file got a second note");
    assert!(rescans(&seen) <= 6, "{} rescans", rescans(&seen));
}

/// The open walk applies the facts that arrive while it runs, between its files, so a long
/// walk does not leave the queue to fill up behind it.
#[test]
fn facts_that_arrive_during_the_open_walk_are_applied_before_it_ends() {
    let mut f = fixture();
    for n in 0..3 {
        f.write(&format!("before/n{n}.md"), &format!("there before {n}\n"));
    }
    let root = f.root.clone();
    *f.identity.during_adopt.lock().unwrap() = Some(Box::new(move || {
        std::fs::write(root.join("live.md"), "written during the walk\n").unwrap();
        std::thread::sleep(Duration::from_millis(2500));
    }));
    let _running = run(&f, 1024);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    let live = seen
        .iter()
        .position(|f| matches!(f, Applied::Added { path, .. } if path == "live.md"));
    let indexed = seen
        .iter()
        .position(|f| matches!(f, Applied::Indexed { .. }));
    assert!(live < indexed && live.is_some(), "{seen:?}");
}
