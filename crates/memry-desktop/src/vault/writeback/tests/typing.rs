//! The "When" invariants for a note being typed, on the real pass and the real write-back
//! thread: the #3529 acceptance rows "two edits 300 ms apart cause one write" and "a 49 KB note
//! is never written more often than once per 5000 ms while typing at 450 ms intervals".
//!
//! Times are the machine's, and a loaded one stretches them: a 450 ms pause may last past the
//! debounce, which makes the note quiet there, and a pass may start a while after the thread
//! took the note, after the next schedule even. So every rule is checked in a form that holds
//! for any stretch: each pass belongs to its own schedule whose debounce had ended when the
//! pass started and after which the note was quiet for the debounce (the last schedule, or a
//! pause that really lasted that long), and no pass starts inside the cooldown of the one
//! before it. On a machine that keeps time, that leaves exactly the passes the rows name.

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
/// `pad` makes every pass cost at least that much, so its cooldown (9 times the cost) outlasts
/// a debounce on a machine of any speed.
struct Timed {
    pass: Pass,
    pad: Duration,
    runs: Arc<Mutex<Vec<Run>>>,
}

impl Runner for Timed {
    fn run(&self, note_id: &str) -> Outcome {
        let started = Instant::now();
        std::thread::sleep(self.pad);
        let outcome = self.pass.run(note_id);
        let run = (started, Instant::now(), outcome.clone());
        self.runs.lock().unwrap().push(run);
        outcome
    }

    fn title(&self, note_id: &str) -> Option<String> {
        Runner::title(&self.pass, note_id)
    }
}

fn timed(f: &mut Fixture, pad: Duration) -> (WriteBack, Arc<Mutex<Vec<Run>>>) {
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
        pad,
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

/// The rules every pass of a typed note keeps. Each runs for a schedule of its own, in order:
/// one whose debounce had ended when the pass started, and after which the next schedule came
/// no sooner than the debounce (a pass is taken once the note was quiet that long, and a
/// schedule after the take does not undo it). None starts inside the cooldown of the pass
/// before it.
fn assert_paced(runs: &[Run], scheduled: &[(Instant, Instant)]) {
    let quiet_after = |i: usize| {
        scheduled
            .get(i + 1)
            .is_none_or(|next| next.1 - scheduled[i].0 >= DEBOUNCE)
    };
    let mut next = 0;
    for run in runs {
        let schedule =
            (next..scheduled.len()).find(|&i| scheduled[i].0 + DEBOUNCE <= run.0 && quiet_after(i));
        let Some(schedule) = schedule else {
            panic!("a pass ran while the note was being typed: {runs:?} {scheduled:?}");
        };
        next = schedule + 1;
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

/// Every pass wrote the body or found the file saying it already: a pass that a stall let run
/// after an edit but before its schedule writes that edit, and the schedule's own pass then
/// finds nothing to write.
fn assert_wrote_or_unchanged(runs: &[Run]) {
    assert!(
        runs.iter()
            .all(|run| matches!(run.2, Outcome::Wrote { .. } | Outcome::Unchanged)),
        "{runs:?}"
    );
}

#[test]
fn two_edits_300_ms_apart_are_one_write() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    let (writeback, runs) = timed(&mut f, Duration::ZERO);
    let first = type_and_schedule(&f, &writeback, &id, "typed first");
    std::thread::sleep(Duration::from_millis(300));
    let second = type_and_schedule(&f, &writeback, &id, "typed second");
    let scheduled = [first, second];
    let runs = settled(&runs, second.0);
    assert_paced(&runs, &scheduled);
    assert_eq!(f.read("n.md"), "typed second\n");
    assert_wrote_or_unchanged(&runs);
    // One pass, after the second edit; a second one only for a 300 ms this machine stretched
    // past the debounce (`assert_paced`).
    assert!(!runs.is_empty());
}

/// 5.4 s of typing at 450 ms writes nothing; a pause the debounce ends writes once; typing on
/// writes again only once the cooldown of that write is over, which here outlasts the debounce
/// (the pass costs at least 300 ms, so it cools 2.7 s), so the cooldown is what the last pass
/// waits for.
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
    let (writeback, runs) = timed(&mut f, Duration::from_millis(300));
    let mut scheduled = Vec::new();
    let mut type_for = |from: u32, to: u32| {
        let start = Instant::now();
        for n in from..to {
            scheduled.push(type_and_schedule(
                &f,
                &writeback,
                &id,
                &format!("typed {n}"),
            ));
            let next = start + TYPING * (n - from + 1);
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
    };
    // Longer than the longest cooldown.
    type_for(0, 12);
    // The pause: the pass after it, then typing again right away.
    let paused = Instant::now();
    let deadline = Instant::now() + WAIT;
    while !runs.lock().unwrap().iter().any(|run| run.0 >= paused) {
        assert!(Instant::now() < deadline, "no pass in the pause");
        std::thread::sleep(Duration::from_millis(10));
    }
    type_for(12, 15);
    let runs = settled(&runs, scheduled.last().unwrap().0);
    assert_paced(&runs, &scheduled);
    let file = f.read("n.md");
    assert!(file.starts_with("typed 14\n"), "{}", &file[..40]);
    assert!(file.len() >= 49 * 1024);
    assert_wrote_or_unchanged(&runs);
    // One write in the pause and one after the cooldown; each pause of the typing this machine
    // stretched past the debounce may add one (`assert_paced`).
    assert!(runs.len() >= 2, "{runs:?}");
}
