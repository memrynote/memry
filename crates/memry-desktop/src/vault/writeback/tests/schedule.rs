//! When passes run (the "When" invariants). A [`Fake`] runner times them and says what each
//! came to; the real pass on the write-back thread closes the file.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use super::super::schedule::{Cost, Runner, due_at};
use super::super::{COOLDOWN_FACTOR, DEBOUNCE, MAX_COOLDOWN, WriteBack, WriteBackFailed};
use super::*;

/// Well under the debounce: no pass may start within it.
const SOON: Duration = Duration::from_millis(300);
const WAIT: Duration = Duration::from_secs(10);
/// Well short of [`MAX_COOLDOWN`]: after [`cool`], a pass that waited for its note's cooldown
/// is not seen within this, however slow the machine. Bounds tied to the debounce flaked on a
/// loaded runner.
const SHORT_OF_COOLDOWN: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Script {
    /// Each pass's note, start and end.
    runs: Vec<(String, Instant, Option<Instant>)>,
    /// What the next passes come to; `Unchanged` when none is left.
    outcomes: VecDeque<Outcome>,
    /// Passes wait while it is shut, `WAIT` at most.
    shut: bool,
    took: Duration,
}

#[derive(Clone, Default)]
struct Fake(Arc<(Mutex<Script>, Condvar)>);

const PANIC: &str = "panic";

impl Fake {
    fn with(&self, f: impl FnOnce(&mut Script)) {
        f(&mut self.0.0.lock().unwrap());
        self.0.1.notify_all();
    }

    fn runs(&self) -> Vec<(String, Instant, Option<Instant>)> {
        self.0.0.lock().unwrap().runs.clone()
    }

    fn count(&self) -> usize {
        self.runs().len()
    }

    fn finished(&self) -> usize {
        self.runs().iter().filter(|run| run.2.is_some()).count()
    }
}

impl Runner for Fake {
    fn run(&self, note_id: &str) -> Outcome {
        let (script, open) = &*self.0;
        let mut s = script.lock().unwrap();
        s.runs.push((note_id.to_owned(), Instant::now(), None));
        let at = s.runs.len() - 1;
        open.notify_all();
        // Opens by itself after `WAIT`, so a test that fails with it shut ends.
        let deadline = Instant::now() + WAIT;
        while s.shut && Instant::now() < deadline {
            s = open.wait_timeout(s, deadline - Instant::now()).unwrap().0;
        }
        let (took, outcome) = (s.took, s.outcomes.pop_front());
        drop(s);
        std::thread::sleep(took);
        script.lock().unwrap().runs[at].2 = Some(Instant::now());
        match outcome {
            Some(Outcome::Failed(reason)) if reason == PANIC => panic!("a pass panicked"),
            outcome => outcome.unwrap_or(Outcome::Unchanged),
        }
    }

    fn title(&self, note_id: &str) -> Option<String> {
        // Slow, so a flush that returned before the notice went out would miss it.
        std::thread::sleep(Duration::from_millis(50));
        Some(format!("title of {note_id}"))
    }
}

fn start(fake: &Fake) -> (WriteBack, broadcast::Receiver<WriteBackFailed>) {
    let (tx, rx) = broadcast::channel(16);
    (WriteBack::start(fake.clone(), tx).unwrap(), rx)
}

/// Runs one pass of `id` that costs enough for the longest cooldown, so a pass of it that is
/// not due now is due [`MAX_COOLDOWN`] after it.
fn cool(fake: &Fake, writeback: &WriteBack, id: &str) {
    fake.with(|s| s.took = MAX_COOLDOWN / COOLDOWN_FACTOR + Duration::from_millis(50));
    writeback.schedule(id);
    assert!(writeback.flush(WAIT));
    fake.with(|s| s.took = Duration::ZERO);
}

fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_pass_is_due_after_the_debounce_or_when_the_last_passs_cooldown_ends() {
    let now = Instant::now();
    assert_eq!(due_at(now, None), now + DEBOUNCE);
    let cheap = Cost {
        finished: now,
        took: Duration::from_millis(20),
    };
    assert_eq!(
        due_at(now, Some(cheap)),
        now + DEBOUNCE,
        "the debounce is the floor"
    );
    let dear = Cost {
        finished: now,
        took: Duration::from_millis(200),
    };
    assert_eq!(
        due_at(now, Some(dear)),
        now + Duration::from_millis(200) * COOLDOWN_FACTOR
    );
    let huge = Cost {
        finished: now,
        took: Duration::from_secs(30),
    };
    assert_eq!(due_at(now, Some(huge)), now + MAX_COOLDOWN);
    let long_ago = Cost {
        finished: now - Duration::from_secs(10),
        took: Duration::from_secs(1),
    };
    assert_eq!(due_at(now, Some(long_ago)), now + DEBOUNCE);
}

/// Typing keeps scheduling the note; it is written once the typing stops. A busy machine may
/// stretch a pause past the debounce, which is a quiet note then, so the rule checked is: no
/// pass starts sooner than the debounce after the schedule before it.
#[test]
fn every_schedule_starts_the_debounce_again_and_the_quiet_note_gets_one_pass() {
    let fake = Fake::default();
    let (writeback, _) = start(&fake);
    let mut scheduled = Vec::new();
    for _ in 0..6 {
        scheduled.push(Instant::now());
        writeback.schedule("n1");
        std::thread::sleep(Duration::from_millis(150));
    }
    let last = *scheduled.last().unwrap();
    eventually("the quiet note's pass", || {
        fake.runs().iter().any(|run| run.1 >= last)
    });
    std::thread::sleep(DEBOUNCE + SOON);
    let runs = fake.runs();
    for run in &runs {
        let before = scheduled.iter().filter(|at| **at <= run.1).max().unwrap();
        assert!(
            run.1 >= *before + DEBOUNCE,
            "a pass ran while the note was being edited"
        );
    }
    let quiet = scheduled
        .windows(2)
        .filter(|w| w[1] - w[0] >= DEBOUNCE)
        .count();
    assert_eq!(runs.len(), quiet + 1);
}

#[test]
fn the_next_pass_waits_for_the_cooldown_of_the_last() {
    let fake = Fake::default();
    fake.with(|s| s.took = Duration::from_millis(200));
    let (writeback, _) = start(&fake);
    writeback.schedule("n1");
    eventually("the first pass", || fake.finished() == 1);
    writeback.schedule("n1");
    eventually("the second pass", || fake.count() == 2);
    let runs = fake.runs();
    let gap = runs[1].1 - runs[0].2.unwrap();
    // The cooldown is 9 x 200 ms of the pass; the pass's own measure is a little longer.
    assert!(gap >= Duration::from_millis(1750), "{gap:?}");
}

/// A schedule taken while the pass runs (or after it returned, before its cost was kept)
/// waits for that pass's cooldown too, not only the debounce (#3718's merge-queue run).
#[test]
fn a_schedule_during_a_pass_waits_for_that_passs_cooldown() {
    let fake = Fake::default();
    fake.with(|s| {
        s.shut = true;
        s.took = Duration::from_millis(200);
    });
    let (writeback, _) = start(&fake);
    writeback.schedule("n1");
    eventually("the first pass", || fake.count() == 1);
    writeback.schedule("n1");
    fake.with(|s| s.shut = false);
    eventually("the second pass", || fake.count() == 2);
    let runs = fake.runs();
    let gap = runs[1].1 - runs[0].2.unwrap();
    assert!(
        gap >= Duration::from_millis(200) * COOLDOWN_FACTOR,
        "{gap:?}"
    );
}

#[test]
fn a_schedule_during_a_pass_gives_one_more_pass_after_it() {
    let fake = Fake::default();
    fake.with(|s| s.shut = true);
    let (writeback, _) = start(&fake);
    writeback.schedule("n1");
    eventually("the pass", || fake.count() == 1);
    writeback.schedule("n1");
    writeback.schedule("n1");
    fake.with(|s| s.shut = false);
    eventually("one more pass", || fake.count() == 2);
    std::thread::sleep(DEBOUNCE + SOON);
    assert_eq!(fake.count(), 2);
}

#[test]
fn a_flush_runs_every_scheduled_pass_now_and_waits_for_them() {
    let fake = Fake::default();
    let (writeback, _) = start(&fake);
    cool(&fake, &writeback, "n1");
    fake.with(|s| s.took = Duration::from_millis(20));
    for id in ["n1", "n2", "n3"] {
        writeback.schedule(id);
    }
    // Now: a flush that waited for n1's cooldown would run out of this time.
    assert!(writeback.flush(SHORT_OF_COOLDOWN));
    assert_eq!(fake.finished(), 4);
    assert!(writeback.flush(WAIT), "a flush with nothing scheduled");
}

#[test]
fn a_flush_waits_for_the_running_pass_and_gives_up_at_its_timeout() {
    let fake = Fake::default();
    fake.with(|s| s.shut = true);
    let (writeback, _) = start(&fake);
    writeback.schedule("n1");
    // The pass stays shut for `WAIT`: a flush that did not give up would see it finish.
    assert!(!writeback.flush(Duration::from_millis(200)));
    assert_eq!(fake.count(), 1, "the flush did not start the pass");
    fake.with(|s| s.shut = false);
    assert!(writeback.flush(WAIT));
    assert_eq!(fake.finished(), 1);
}

#[test]
fn a_schedule_during_a_flush_is_due_at_once() {
    let fake = Fake::default();
    let (writeback, _) = start(&fake);
    cool(&fake, &writeback, "n2");
    fake.with(|s| s.shut = true);
    let writeback = Arc::new(writeback);
    writeback.schedule("n1");
    let flushing = {
        let writeback = writeback.clone();
        // A flush that waited for n2's cooldown would run out of this time.
        std::thread::spawn(move || writeback.flush(SHORT_OF_COOLDOWN))
    };
    eventually("the flushed pass", || fake.count() == 2);
    writeback.schedule("n2");
    fake.with(|s| s.shut = false);
    assert!(flushing.join().unwrap());
    assert_eq!(fake.runs()[2].0, "n2");
}

#[test]
fn a_stop_runs_every_scheduled_pass_before_the_thread_ends() {
    let fake = Fake::default();
    let (writeback, _) = start(&fake);
    cool(&fake, &writeback, "n1");
    writeback.schedule("n1");
    writeback.schedule("n2");
    writeback.stop();
    assert_eq!(fake.finished(), 3);
    let runs = fake.runs();
    let (cooled, stopped) = (
        runs[0].2.unwrap(),
        runs.iter().rfind(|r| r.0 == "n1").unwrap().1,
    );
    // timing-bound: a stop that waited for n1's cooldown starts its pass no sooner than
    // MAX_COOLDOWN (5 s) after the cool pass; one that does not starts it at once.
    assert!(
        stopped.duration_since(cooled) < MAX_COOLDOWN,
        "{:?}",
        stopped.duration_since(cooled)
    );
    writeback.schedule("n3");
    assert!(writeback.flush(Duration::from_millis(100)));
    assert_eq!(fake.count(), 3, "a pass ran after the stop");
}

/// Two stoppers (a late close hook and the next open): each returns only once the thread ended.
#[test]
fn a_second_stop_returns_only_once_the_thread_has_ended() {
    let fake = Fake::default();
    fake.with(|s| s.shut = true);
    let (writeback, _) = start(&fake);
    let writeback = Arc::new(writeback);
    writeback.schedule("n1");
    let first = {
        let writeback = writeback.clone();
        std::thread::spawn(move || writeback.stop())
    };
    eventually("the pass", || fake.count() == 1);
    let second = {
        let (writeback, fake) = (writeback.clone(), fake.clone());
        std::thread::spawn(move || {
            writeback.stop();
            fake.finished()
        })
    };
    std::thread::sleep(SOON);
    assert!(
        !second.is_finished(),
        "the second stop returned with the pass running"
    );
    fake.with(|s| s.shut = false);
    assert_eq!(second.join().unwrap(), 1);
    first.join().unwrap();
}

#[test]
fn a_failed_write_is_told_once_per_run_of_failures() {
    let fake = Fake::default();
    let failed = || Outcome::Failed("disk full".into());
    fake.with(|s| {
        s.outcomes = [
            failed(),
            failed(),
            Outcome::Kept(Keep::FileChanged),
            failed(),
        ]
        .into()
    });
    let (writeback, mut told) = start(&fake);
    let mut events = Vec::new();
    for _ in 0..4 {
        writeback.schedule("n1");
        assert!(writeback.flush(WAIT));
        events.extend(std::iter::from_fn(|| told.try_recv().ok()));
    }
    let event = WriteBackFailed {
        note_id: "n1".into(),
        title: Some("title of n1".into()),
    };
    assert_eq!(events, vec![event.clone(), event]);
}

#[test]
fn a_pass_that_panics_is_a_failed_one_and_the_next_still_runs() {
    let fake = Fake::default();
    fake.with(|s| s.outcomes = [Outcome::Failed(PANIC.into())].into());
    let (writeback, mut told) = start(&fake);
    writeback.schedule("n1");
    assert!(writeback.flush(WAIT));
    assert_eq!(told.try_recv().unwrap().note_id, "n1");
    writeback.schedule("n2");
    assert!(writeback.flush(WAIT));
    assert_eq!(fake.count(), 2);
}

fn real(f: &mut Fixture) -> (WriteBack, broadcast::Receiver<WriteBackFailed>) {
    let pass = std::mem::replace(
        &mut f.pass,
        Pass::new(
            f.root.clone(),
            f.vault.clone(),
            f.rows.clone(),
            f.rows.session_for(&f.vault).unwrap(),
            f.echo.clone(),
            None,
        ),
    );
    let (tx, rx) = broadcast::channel(16);
    (WriteBack::start(pass, tx).unwrap(), rx)
}

/// The seam Steps 14 and 17 call, with the real pass: the flush and the stop both bring the
/// scheduled body to the file.
#[test]
fn a_scheduled_note_is_written_by_the_flush_and_by_the_stop() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    let (writeback, _) = real(&mut f);
    f.edit_in_app(&id, "typed in the app");
    writeback.schedule(&id);
    assert!(writeback.flush(WAIT));
    assert_eq!(f.read("n.md"), "typed in the app\n");
    f.edit_in_app(&id, "typed before the close");
    writeback.schedule(&id);
    writeback.stop();
    assert_eq!(f.read("n.md"), "typed before the close\n");
    let changed = f
        .facts()
        .into_iter()
        .filter(|fact| matches!(fact, Applied::Changed { .. }))
        .count();
    assert_eq!(changed, 2);
}

/// The notice names the note, read from its record.
#[cfg(unix)]
#[test]
fn a_note_whose_file_cannot_be_read_is_told_with_its_title() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.writer.rename(id.clone(), "Groceries".into()).unwrap();
    let (writeback, mut told) = real(&mut f);
    f.edit_in_app(&id, "typed in the app");
    let path = f.root.join("n.md");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    writeback.schedule(&id);
    assert!(writeback.flush(WAIT));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        told.try_recv().unwrap(),
        WriteBackFailed {
            note_id: id,
            title: Some("Groceries".into()),
        }
    );
}
