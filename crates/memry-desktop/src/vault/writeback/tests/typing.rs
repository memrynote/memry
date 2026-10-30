//! The "When" invariants for a note being typed, on the real pass and the real write-back
//! thread: the #3529 acceptance rows "two edits 300 ms apart cause one write" and "a 49 KB note
//! is never written more often than once per 5000 ms while typing at 450 ms intervals".
//!
//! Times are the machine's: a loaded one may stretch a pause past the debounce, which makes
//! the note quiet there. So each rule is checked as a lower bound (no pass sooner than the
//! debounce after the schedule before it, nor sooner than the last pass's cooldown after it)
//! and the pass count against the pauses that really were quiet.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::super::schedule::Runner;
use super::super::{COOLDOWN_FACTOR, DEBOUNCE, MAX_COOLDOWN, WriteBack};
use super::*;

const WAIT: Duration = Duration::from_secs(20);
const TYPING: Duration = Duration::from_millis(450);

/// One pass: when it started and ended, and what it came to.
type Run = (Instant, Instant, Outcome);

/// The real pass, timed from inside, so its start and end bound the thread's own measure.
struct Timed {
    pass: Pass,
    runs: Arc<Mutex<Vec<Run>>>,
}

impl Runner for Timed {
    fn run(&self, note_id: &str) -> Outcome {
        let started = Instant::now();
        let outcome = self.pass.run(note_id);
        let run = (started, Instant::now(), outcome.clone());
        self.runs.lock().unwrap().push(run);
        outcome
    }

    fn title(&self, note_id: &str) -> Option<String> {
        Runner::title(&self.pass, note_id)
    }
}

fn timed(f: &mut Fixture) -> (WriteBack, Arc<Mutex<Vec<Run>>>) {
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
    let runs: Arc<Mutex<Vec<Run>>> = Arc::default();
    let (tx, _) = broadcast::channel(16);
    let runner = Timed {
        pass,
        runs: runs.clone(),
    };
    (WriteBack::start(runner, tx).unwrap(), runs)
}

/// One edit typed in the app and scheduled: the instants just before and just after the
/// schedule, which bound when it was taken.
fn type_and_schedule(
    f: &Fixture,
    writeback: &WriteBack,
    id: &str,
    text: &str,
) -> (Instant, Instant) {
    f.edit_in_app(id, text);
    let before = Instant::now();
    writeback.schedule(id);
    (before, Instant::now())
}

/// Waits for the pass after the last schedule, then a debounce more for any pass that should
/// not come.
fn settled(runs: &Mutex<Vec<Run>>, last: Instant) -> Vec<Run> {
    let deadline = Instant::now() + WAIT;
    while !runs.lock().unwrap().iter().any(|run| run.0 >= last) {
        assert!(Instant::now() < deadline, "no pass after the typing");
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
    runs.lock().unwrap().clone()
}

/// The rules every pass of a typed note keeps: none starts sooner than the debounce after the
/// schedule before it, or sooner than the cooldown of the pass before it after that one.
fn assert_paced(runs: &[Run], scheduled: &[(Instant, Instant)]) {
    for run in runs {
        let before = scheduled
            .iter()
            .map(|at| at.0)
            .filter(|at| *at <= run.0)
            .max()
            .unwrap();
        assert!(
            run.0 >= before + DEBOUNCE,
            "a pass ran while the note was being typed"
        );
    }
    for pair in runs.windows(2) {
        let cooldown = (pair[0].1 - pair[0].0)
            .saturating_mul(COOLDOWN_FACTOR)
            .min(MAX_COOLDOWN);
        assert!(
            pair[1].0 >= pair[0].1 + cooldown,
            "a pass ran inside the cooldown of the one before it"
        );
    }
}

/// The pauses that may have been quiet: from just before one schedule to just after the next.
fn quiet_pauses(scheduled: &[(Instant, Instant)]) -> usize {
    scheduled
        .windows(2)
        .filter(|w| w[1].1 - w[0].0 >= DEBOUNCE)
        .count()
}

fn wrote(runs: &[Run]) -> usize {
    runs.iter()
        .filter(|run| matches!(run.2, Outcome::Wrote { .. }))
        .count()
}

#[test]
fn two_edits_300_ms_apart_are_one_write() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    let (writeback, runs) = timed(&mut f);
    let first = type_and_schedule(&f, &writeback, &id, "typed first");
    std::thread::sleep(Duration::from_millis(300));
    let second = type_and_schedule(&f, &writeback, &id, "typed second");
    let scheduled = [first, second];
    let runs = settled(&runs, second.0);
    assert_paced(&runs, &scheduled);
    assert_eq!(f.read("n.md"), "typed second\n");
    assert_eq!(wrote(&runs), runs.len(), "{runs:?}");
    // Two passes only when this machine stretched the 300 ms past the debounce.
    assert_eq!(runs.len(), 1 + quiet_pauses(&scheduled), "{runs:?}");
}

#[test]
fn a_49_kb_note_typed_every_450_ms_is_written_once_the_typing_stops() {
    let mut f = fixture();
    let mut text = String::new();
    // 49 KB once its first paragraph is the shorter typed line.
    for n in 0.. {
        if text.len() >= 49 * 1024 + 100 {
            break;
        }
        text.push_str(&format!(
            "Paragraph {n} of a long note, with words enough to fill a line of it.\n\n"
        ));
    }
    let id = f.adopt("n.md", &text);
    let (writeback, runs) = timed(&mut f);
    let start = Instant::now();
    let mut scheduled = Vec::new();
    // 5.4 s of typing: longer than the longest cooldown.
    for n in 0..12u32 {
        scheduled.push(type_and_schedule(
            &f,
            &writeback,
            &id,
            &format!("typed {n}"),
        ));
        let next = start + TYPING * (n + 1);
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
    let runs = settled(&runs, scheduled.last().unwrap().0);
    assert_paced(&runs, &scheduled);
    let file = f.read("n.md");
    assert!(file.starts_with("typed 11\n"), "{}", &file[..40]);
    assert!(file.len() >= 49 * 1024);
    assert_eq!(wrote(&runs), runs.len(), "{runs:?}");
    // A pause of 450 ms never ends the debounce: one write, after the typing. Each pause this
    // machine stretched past it may add one, still a cooldown after the pass before.
    assert!(
        (1..=1 + quiet_pauses(&scheduled)).contains(&runs.len()),
        "{runs:?}"
    );
}
