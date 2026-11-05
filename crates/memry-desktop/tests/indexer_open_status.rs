//! What the vault status says about indexing (#3969), over a real session, tier and watcher: an
//! open is indexing from the open to the end of its pass, with the pass's counts once it has
//! one, and a close or a reindex's answer ends it. Each change reaches the shell as
//! [`IndexReport::Indexing`], and the status it sends again goes out only while a vault is open
//! and the app is not quitting.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use index_support::{seeded, until};
use memry_desktop::notes::index::{IndexProgress, IndexReport, NoteIndex};
use memry_desktop::session::OpenSource;
use memry_desktop::session::response::VaultStatus;

const NOTES: usize = 30;

/// What the shell heard, each with what [`NoteIndex::indexing`] said when it heard it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Heard {
    Progress(IndexProgress),
    Indexing(Option<IndexProgress>),
}

#[derive(Default)]
struct Shell {
    index: OnceLock<Arc<NoteIndex>>,
    heard: Mutex<Vec<Heard>>,
    /// Set: the first step of the open's pass goes here, and the pass waits for the reply.
    hold: Mutex<Option<(Sender<IndexProgress>, Receiver<()>)>>,
    /// Set: the next step panics, as a bug in the task would.
    panic: AtomicBool,
}

impl Shell {
    fn index(self: &Arc<Self>, e: &vault_env::Env) -> Arc<NoteIndex> {
        let shell = self.clone();
        let index = NoteIndex::new(
            e.tier.clone(),
            move |report| shell.hear(report),
            |_| {},
            |_| {},
        );
        index.register(&e.session);
        assert!(self.index.set(index.clone()).is_ok());
        index
    }

    fn hear(&self, report: IndexReport) {
        let indexing = self.index.get().and_then(|index| index.indexing());
        let heard = match report {
            IndexReport::Progress(step) => Heard::Progress(step),
            IndexReport::Indexing => Heard::Indexing(indexing),
        };
        self.heard.lock().unwrap().push(heard);
        if matches!(report, IndexReport::Progress(_)) && self.panic.swap(false, Ordering::SeqCst) {
            panic!("a bug in the index task");
        }
        if let IndexReport::Progress(step) = report {
            // Taken first: the hold's lock is not kept while the pass waits.
            let held = self.hold.lock().unwrap().take();
            if let Some((tell, wait)) = held {
                tell.send(step).unwrap();
                wait.recv().unwrap();
            }
        }
    }

    /// The next first step of a pass waits until the returned sender is used.
    fn hold(&self) -> (Receiver<IndexProgress>, Sender<()>) {
        let (tell, told) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        *self.hold.lock().unwrap() = Some((tell, wait));
        (told, release)
    }

    fn heard(&self) -> Vec<Heard> {
        self.heard.lock().unwrap().clone()
    }
}

fn step(built: usize, total: usize) -> IndexProgress {
    IndexProgress { built, total }
}

#[test]
fn an_open_is_indexing_until_its_pass_ended_and_shows_counts_once_a_step_came() {
    let (mut e, _store, _) = seeded(NOTES);
    let shell = Arc::new(Shell::default());
    let index = shell.index(&e);
    let (first, release) = shell.hold();
    e.open();

    // Before the pass's first step the open is indexing without counts ("Indexing…").
    let before = index.indexing().expect("the open is indexing");
    let status = VaultStatus::from(e.session.status()).with_indexing(Some(before));
    assert!(status.is_indexing, "{status:?}");
    if before == IndexProgress::default() {
        assert_eq!((status.index_built, status.index_total), (None, None));
    }

    let held = first.recv().unwrap();
    assert_eq!(held, step(0, NOTES));
    assert_eq!(index.indexing(), Some(held), "the step the pass is at");
    assert_eq!(
        shell.heard().last(),
        Some(&Heard::Progress(held)),
        "the shell heard the step after the index named it"
    );
    let status = VaultStatus::from(e.session.status()).with_indexing(index.indexing());
    assert_eq!(
        (status.is_indexing, status.index_built, status.index_total),
        (true, Some(0), Some(NOTES as u32))
    );
    release.send(()).unwrap();

    until("the open's pass ended", || index.indexing().is_none());
    until("the shell heard the end", || {
        shell.heard().last() == Some(&Heard::Indexing(None))
    });
    let heard = shell.heard();
    let total = heard
        .iter()
        .position(|h| *h == Heard::Progress(step(NOTES, NOTES)))
        .expect("the pass reported its total");
    assert!(
        heard[..total].contains(&Heard::Indexing(Some(step(0, NOTES)))),
        "{heard:?}"
    );
    assert!(
        !VaultStatus::from(e.session.status())
            .with_indexing(index.indexing())
            .is_indexing
    );
    e.close();
}

#[test]
fn a_close_inside_the_opens_pass_ends_its_indexing() {
    let (mut e, _store, _) = seeded(NOTES);
    let shell = Arc::new(Shell::default());
    let index = shell.index(&e);
    let (first, release) = shell.hold();
    e.open();
    first.recv().unwrap();

    let session = e.session.clone();
    let releaser = std::thread::spawn(move || {
        until("the close to begin", || session.current().is_none());
        release.send(()).unwrap();
    });
    e.close();
    releaser.join().unwrap();
    assert_eq!(index.indexing(), None);

    // The next open indexes again.
    e.open();
    assert!(index.indexing().is_some());
    until("the open's pass ended", || index.indexing().is_none());
    e.close();
}

#[test]
fn an_index_task_that_panics_leaves_no_indexing() {
    let (mut e, _store, _) = seeded(NOTES);
    let shell = Arc::new(Shell::default());
    let index = shell.index(&e);
    shell.panic.store(true, Ordering::SeqCst);
    e.open();
    until("the task's end cleared the open's build", || {
        index.indexing().is_none()
    });
    assert_eq!(shell.heard().last(), Some(&Heard::Indexing(None)));
    e.close();
}

/// A close gives up on a task that overran its deadline, and the next open starts its own build.
/// When the old task ends at last, the new build stays on.
#[test]
fn an_earlier_opens_task_that_ends_late_leaves_the_next_builds_indexing() {
    let (mut e, _store, _) = seeded(NOTES);
    let shell = Arc::new(Shell::default());
    let index = shell.index(&e);
    let (first, release_old) = shell.hold();
    e.open();
    let old = Arc::downgrade(&e.core());
    first.recv().unwrap();

    // The old task is held inside its first step, past the close's deadline.
    e.close();
    let other = e._dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let (next, release_new) = shell.hold();
    e.session.open(&other, OpenSource::Select).unwrap();
    next.recv().unwrap();
    assert!(index.indexing().is_some());

    release_old.send(()).unwrap();
    until("the old task ended", || old.strong_count() == 0);
    assert!(
        index.indexing().is_some(),
        "the old task's end left the new open's build on"
    );
    release_new.send(()).unwrap();
    until("the new open's pass ended", || index.indexing().is_none());
    e.session.close();
}

#[test]
fn a_reindex_tells_the_shell_when_it_starts_steps_and_ends() {
    let (mut e, _store, _) = seeded(NOTES);
    let shell = Arc::new(Shell::default());
    let index = shell.index(&e);
    e.open();
    until("the open's pass ended", || index.indexing().is_none());
    shell.heard.lock().unwrap().clear();

    let steps = Arc::new(Mutex::new(Vec::new()));
    let seen = steps.clone();
    index
        .reindex(move |step| seen.lock().unwrap().push(step))
        .unwrap();
    assert_eq!(index.indexing(), None, "answered, so no longer indexing");

    let heard = shell.heard();
    let steps = steps.lock().unwrap().clone();
    assert_eq!(steps.first(), Some(&step(0, NOTES)));
    assert_eq!(steps.last(), Some(&step(NOTES, NOTES)));
    // Asked, then one per step, then answered; no open's progress.
    let mut told = vec![Heard::Indexing(Some(IndexProgress::default()))];
    told.extend(steps.iter().map(|s| Heard::Indexing(Some(*s))));
    told.push(Heard::Indexing(None));
    assert_eq!(heard, told);
    e.close();
}

#[test]
fn the_status_an_index_change_sends_goes_out_only_while_open_and_not_quitting() {
    let (mut e, _store, _) = seeded(1);
    let indexing = Some(step(1, 3));
    assert_eq!(VaultStatus::resend(&e.session, indexing), None, "closed");
    e.open();
    let sent = VaultStatus::resend(&e.session, indexing).expect("open");
    assert!(sent.is_open && sent.is_indexing);
    assert_eq!((sent.index_built, sent.index_total), (Some(1), Some(3)));
    let done = VaultStatus::resend(&e.session, None).expect("open");
    assert!(done.is_open && !done.is_indexing);

    e.session.begin_shutdown();
    assert_eq!(VaultStatus::resend(&e.session, indexing), None, "quitting");
    e.close();
    assert_eq!(VaultStatus::resend(&e.session, None), None);
}
