//! Reindexes asked together share one pass (REVIEW-5806 finding 2): the askers waiting when a
//! pass starts are all answered by it, a failed one included, and one asked during it gets a
//! pass of its own after it, so it is never answered by work that started before it asked.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use index_support::{seeded, with_cancellable_task, with_task};
use memry_desktop::notes::index::{Backfilled, IndexError, IndexProgress, TaskHandle};
use memry_desktop::vault::consumer::Applied;
use tokio::sync::broadcast;

type Answer = Receiver<Result<Backfilled, IndexError>>;

/// Every step each asker was told, as `(asker, step)`, in the order they were told.
type Told = Arc<Mutex<Vec<(usize, IndexProgress)>>>;

fn ask(task: &TaskHandle, told: &Told, asker: usize) -> Answer {
    let told = told.clone();
    task.reindex(Box::new(move |step| {
        told.lock().unwrap().push((asker, step))
    }))
    .unwrap()
}

fn told(told: &Told) -> Vec<(usize, IndexProgress)> {
    told.lock().unwrap().clone()
}

/// Five reindexes asked while a first sync holds run one pass once it ended, which answers all
/// five: every asker is told the pass's first step before any is told a later one.
#[test]
fn reindexes_asked_during_a_first_sync_share_one_pass() {
    let (mut e, _store, notes) = seeded(3);
    e.open();
    let open = e.session.current().unwrap();
    let hold = open.first_sync.hold();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        let log = Told::default();
        let answers: Vec<Answer> = (0..5).map(|asker| ask(task, &log, asker)).collect();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        // The inbox is read in order: once the measure is answered, the five askers wait.
        task.measure(notes[0].0.clone())
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert!(told(&log).is_empty(), "no pass while the first sync holds");
        drop(hold);
        for answer in answers {
            assert_eq!(answer.recv().unwrap().unwrap().listed, 3);
        }
        let told = told(&log);
        let first: Vec<_> = told[..5].iter().map(|(asker, _)| *asker).collect();
        assert_eq!(first, [0, 1, 2, 3, 4], "one pass for all five: {told:?}");
        assert!(
            told[..5].iter().all(|(_, step)| *step == told[0].1),
            "{told:?}"
        );
        let ends: Vec<_> = (told.iter())
            .filter(|(_, step)| step.built == step.total)
            .map(|(asker, _)| *asker)
            .collect();
        assert_eq!(ends, [0, 1, 2, 3, 4], "one last step each: {told:?}");
    });
    drop(open);
    e.close();
}

/// A reindex asked while a pass runs is not answered by it: its own pass starts after that
/// pass's last step.
#[test]
fn a_reindex_asked_during_a_pass_gets_a_pass_after_it() {
    let (mut e, _store, _notes) = seeded(3);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        let log = Told::default();
        let late = Arc::new(Mutex::new(None::<Answer>));
        let (handle, asked, seen) = (task.clone(), late.clone(), log.clone());
        let answer = task
            .reindex(Box::new(move |step| {
                seen.lock().unwrap().push((0, step));
                let mut asked = asked.lock().unwrap();
                if asked.is_none() {
                    *asked = Some(ask(&handle, &seen, 1));
                }
            }))
            .unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        answer.recv().unwrap().unwrap();
        let late = late.lock().unwrap().take().expect("asked during the pass");
        late.recv().unwrap().unwrap();
        let told = told(&log);
        let first_late = told.iter().position(|(asker, _)| *asker == 1);
        let last_early = told.iter().rposition(|(asker, _)| *asker == 0);
        assert!(
            first_late > last_early,
            "the late asker's pass starts after the pass it asked during: {told:?}"
        );
        let (_, end) = told.last().unwrap();
        assert_eq!(end.built, end.total, "{told:?}");
    });
    drop(open);
    e.close();
}

/// A shared pass that fails answers every asker it took with the failure, none left unanswered:
/// the second asker is told the first step before the first asker's answer is sent.
#[test]
fn a_failed_shared_pass_answers_every_asker_with_its_error() {
    let (mut e, _store, _notes) = seeded(3);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_cancellable_task(&open, receiver, |task, cancel| {
        // The first step closes the vault under the pass, which stops it.
        let closing = cancel.clone();
        let first = task.reindex(Box::new(move |_| closing.cancel())).unwrap();
        let first = Arc::new(Mutex::new(first));
        // Whether the first asker was answered when the second was told a step; an answer
        // taken to learn it is kept for the check below.
        let before = Arc::new(Mutex::new(None::<bool>));
        let kept = Arc::new(Mutex::new(None));
        let (peek, seen, keep) = (first.clone(), before.clone(), kept.clone());
        let second = task
            .reindex(Box::new(move |_| {
                let mut seen = seen.lock().unwrap();
                if seen.is_none() {
                    let sent = peek.lock().unwrap().try_recv();
                    *seen = Some(sent.is_err());
                    *keep.lock().unwrap() = sent.ok();
                }
            }))
            .unwrap();
        let third = ask(task, &Told::default(), 2);
        sender.send(Applied::Indexed { complete: true }).unwrap();
        // The second and third answers come after every step was told.
        let mut outcomes = vec![second.recv(), third.recv()];
        let held = kept.lock().unwrap().take();
        outcomes.push(held.map_or_else(|| first.lock().unwrap().recv(), Ok));
        for outcome in outcomes {
            let outcome = outcome.expect("answered, not dropped");
            assert!(matches!(outcome, Err(IndexError::NotOpen)), "{outcome:?}");
        }
        assert_eq!(
            *before.lock().unwrap(),
            Some(true),
            "the second asker was told the shared pass's first step"
        );
    });
    drop(open);
    e.close();
}

/// An asker that joins while a first sync holds a pass is told no step below the held pass's:
/// every asker's callback sets the shared `NoteIndex::indexing` before it reports, so the steps
/// told to all askers, in order, are what `indexing()` says, and they never go back.
#[test]
fn an_asker_joining_a_held_pass_never_moves_the_progress_back() {
    let (mut e, _store, notes) = seeded(10);
    e.open();
    let open = e.session.current().unwrap();
    let (sender, receiver) = broadcast::channel(16);
    with_task(&open, receiver, |task| {
        let log = Told::default();
        let hold = Arc::new(Mutex::new(None));
        let (running, taken, seen) = (open.first_sync.clone(), hold.clone(), log.clone());
        let first = task
            .reindex(Box::new(move |step| {
                let mut seen = seen.lock().unwrap();
                if seen.is_empty() {
                    *taken.lock().unwrap() = Some(running.hold());
                }
                seen.push((0, step));
            }))
            .unwrap();
        sender.send(Applied::Indexed { complete: true }).unwrap();
        let full = IndexProgress {
            built: 10,
            total: 10,
        };
        index_support::until("the held pass read every note", || {
            told(&log).contains(&(0, full))
        });
        let joined = ask(task, &log, 1);
        // The inbox is read in order: once the measure is answered, the new asker waits.
        task.measure(notes[0].0.clone())
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert!(first.try_recv().is_err(), "held");
        drop(hold.lock().unwrap().take());
        first.recv().unwrap().unwrap();
        joined.recv().unwrap().unwrap();
        let told = told(&log);
        assert!(
            told.windows(2)
                .all(|pair| pair[0].1.built <= pair[1].1.built),
            "the shared progress went back: {told:?}"
        );
    });
    drop(open);
    e.close();
}
