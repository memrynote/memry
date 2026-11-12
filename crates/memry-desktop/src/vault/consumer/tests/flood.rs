//! More facts than the queue holds. The queue keeps what it has, the watcher resyncs once per
//! finished pass, and the work each round costs is the work there is: files no identity adopts
//! are not reported again.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use super::*;
use crate::vault::consumer::run::{Consumer, Inbox, inbox};
use crate::vault::watch::{EventSink, NewFiles, VaultWatcher};

const FILES: usize = 200;
const WAIT: Duration = Duration::from_secs(60);

pub(super) struct Running {
    _watcher: VaultWatcher,
    _consumer: Consumer,
    /// `Added` events the watcher reported.
    added: Arc<AtomicUsize>,
}

pub(super) fn run(f: &Fixture, capacity: usize) -> Running {
    let (sink, inbox) = inbox(capacity);
    run_on(f, sink, inbox)
}

/// [`run`] on a queue the test made, so it can offer the consumer facts as the watcher does.
fn run_on(f: &Fixture, sink: EventSink, inbox: Inbox) -> Running {
    let adopts = f.identity.adopts();
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
    let consumer = Consumer::start(
        applier,
        inbox,
        watcher.handle(),
        vec![],
        Box::new(|_, _| {}),
    )
    .unwrap();
    Running {
        _watcher: watcher,
        _consumer: consumer,
        added,
    }
}

/// The fact the watcher reports for the new file `rel` of `text`.
fn added(rel: &str, text: &str) -> VaultEvent {
    VaultEvent::Added {
        path: rel.into(),
        file_type: FileType::Markdown,
        size: text.len() as u64,
        modified_ms: 0,
        content_hash: None,
    }
}

fn rescans(facts: &[Applied]) -> usize {
    facts
        .iter()
        .filter(|f| matches!(f, Applied::Vault(VaultEvent::Rescanned { .. })))
        .count()
}

impl Fixture {
    pub(super) fn collect_until(
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

    /// Writes the files when `write`, and offers their facts as the watcher does while the lane
    /// is held, so the consumer is stuck on the first fact and the queue overflows. The facts
    /// are offered, not left to the OS: a loaded machine's FSEvents delivered a fresh watch's
    /// first event 50 s late, sometimes not in two minutes, and writes made before the watch
    /// (#3967). The overflow is what these tests are about.
    fn flood(&self, sink: &EventSink, write: bool) {
        let held = self.rows.lane().unwrap();
        for n in 0..FILES {
            let (rel, text) = (format!("flood/n{n}.md"), format!("file {n}\n"));
            if write {
                self.write(&rel, &text);
            }
            sink(added(&rel, &text));
        }
        drop(held);
    }
}

/// Nothing adopts new files: the resync after the overflow does not report them again
/// (`a_resync_that_adopts_no_new_file_reports_none`), so there is no next overflow, and no
/// loop. The facts name no file on disk: a file written for them would reach the watcher
/// through the OS whenever FSEvents gets to it, and be reported live as any new file is.
#[test]
fn a_flood_of_files_nothing_adopts_costs_one_resync_and_no_second_report() {
    let mut f = fixture();
    f.identity.adopts.store(false, Ordering::SeqCst);
    let (sink, inbox) = inbox(8);
    let running = run_on(&f, sink.clone(), inbox);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    f.flood(&sink, false);
    f.collect_until(&mut seen, |_, s| rescans(s) >= 2);
    // An absence: a repeated resync would come a second after this one's pass.
    std::thread::sleep(Duration::from_secs(5));
    seen.extend(f.facts());
    assert_eq!(rescans(&seen), 2, "the resync repeated: {seen:?}");
    assert_eq!(running.added.load(Ordering::SeqCst), 0);
    assert!(f.adopted().is_empty());
}

/// Every file gets exactly one note although most of the facts were dropped, and the resyncs
/// that found them again are few.
#[test]
fn a_flood_of_new_files_ends_with_one_note_each() {
    let mut f = fixture();
    let (sink, inbox) = inbox(64);
    let _running = run_on(&f, sink.clone(), inbox);
    let mut seen = Vec::new();
    f.collect_until(&mut seen, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. }))
    });
    f.flood(&sink, true);
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
/// walk does not leave the queue to fill up behind it. The fact arrives while the walk applies
/// its first file, offered as the watcher offers it: the walk can apply only a fact it was
/// given, and when the OS delivers one is not up to the walk ([`Fixture::flood`]).
#[test]
fn facts_that_arrive_during_the_open_walk_are_applied_before_it_ends() {
    let mut f = fixture();
    for n in 0..3 {
        f.write(&format!("before/n{n}.md"), &format!("there before {n}\n"));
    }
    let (sink, inbox) = inbox(1024);
    let (offer, root) = (sink.clone(), f.root.clone());
    *f.identity.during_adopt.lock().unwrap() = Some(Box::new(move || {
        let text = "written during the walk\n";
        std::fs::write(root.join("live.md"), text).unwrap();
        offer(added("live.md", text));
    }));
    let _running = run_on(&f, sink, inbox);
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

/// An app write waiting for the lane gets it between two files the open walk applies alone
/// (journal days, a batch's fallbacks, files no device key can seed): the walk holds the lane
/// for one file at a time, as for any file it finds, and the lane serves the app first
/// (`line::Line`). Counted, not timed: the facts go out under the lane, and the app's comes
/// right after the file the walk held the lane for when the app asked.
#[test]
fn an_app_write_gets_the_lane_between_the_files_the_walk_applies_alone() {
    const FILES: usize = 24;
    let mut f = fixture();
    for n in 0..FILES {
        f.write(&format!("alone/n{n}.md"), &format!("there before {n}\n"));
    }
    let app_note = f.note();
    let (rows, session) = (f.rows.clone(), f.session());
    // Runs while the walk holds the lane for its first file: an app save asks for it, and the
    // walk goes on once the save waits in line. The deadline ends the wait only when the lane
    // keeps no line, which the assertion then reports.
    *f.identity.during_adopt.lock().unwrap() = Some(Box::new(move || {
        let saving = rows.clone();
        std::thread::spawn(move || {
            saving
                .reserve(session, &app_note, "app.md", Fixture::stat(1))
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while rows.waiting() == 0 && Instant::now() < deadline {
            std::thread::yield_now();
        }
    }));
    let _running = run(&f, 1024);
    let mut facts = Vec::new();
    let saved = |s: &[Applied]| {
        s.iter()
            .position(|f| matches!(f, Applied::Added { path, .. } if path == "app.md"))
    };
    f.collect_until(&mut facts, |_, s| {
        s.iter().any(|f| matches!(f, Applied::Indexed { .. })) && saved(s).is_some()
    });
    let walked_before = facts[..saved(&facts).unwrap()]
        .iter()
        .filter(|f| matches!(f, Applied::Added { path, .. } if path.starts_with("alone/")))
        .count();
    assert_eq!(
        walked_before, 1,
        "files the walk applied before the app's write: {facts:?}"
    );
    assert_eq!(f.adopted().len(), FILES);
}
