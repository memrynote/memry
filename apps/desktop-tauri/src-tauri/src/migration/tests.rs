use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::electron_import::progress::{Phase, ProgressSink, ProgressUpdate};

use super::status::{MigrationState, MigrationStatus};
use super::{Backend, Migration, MigrationFailure, update_script};

/// Answers each run with the next outcome of its script, after the run's progress updates, and
/// holds a run while `gate` is armed.
struct Script {
    outcomes: Mutex<Vec<Result<(), MigrationFailure>>>,
    runs: AtomicU32,
    gate: Mutex<Option<Receiver<()>>>,
}

impl Script {
    fn new(outcomes: Vec<Result<(), MigrationFailure>>) -> Arc<Self> {
        Arc::new(Self {
            outcomes: Mutex::new(outcomes),
            runs: AtomicU32::new(0),
            gate: Mutex::new(None),
        })
    }

    fn arm(&self) -> Sender<()> {
        let (open, gate) = channel();
        *self.gate.lock().unwrap() = Some(gate);
        open
    }
}

impl Backend for Script {
    fn needed(&self) -> bool {
        true
    }

    fn run(&self, progress: &dyn ProgressSink) -> Result<(), MigrationFailure> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.gate.lock().unwrap().take() {
            gate.recv().unwrap();
        }
        for (phase, current, total) in [(Phase::Secrets, 1, 1), (Phase::Vault, 1, 2)] {
            progress.update(ProgressUpdate {
                phase,
                current,
                total,
                label: String::new(),
            });
        }
        let outcome = self.outcomes.lock().unwrap().remove(0);
        if outcome
            .as_ref()
            .is_err_and(|failure| failure.check == "panic!")
        {
            panic!("the backend panicked");
        }
        outcome
    }

    fn backup(&self) -> PathBuf {
        PathBuf::from("/backup")
    }

    fn take_change_notice(&self) -> bool {
        false
    }
}

struct World {
    migration: Arc<Migration>,
    shown: Arc<Mutex<Vec<MigrationStatus>>>,
    finished: Arc<AtomicU32>,
}

fn world(backend: Arc<Script>) -> World {
    let shown = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicU32::new(0));
    let (page, done) = (shown.clone(), finished.clone());
    let migration = Arc::new(Migration::new(
        backend,
        "en",
        std::path::Path::new("/data"),
        Some(Box::new(move |status: &MigrationStatus| {
            page.lock().unwrap().push(status.clone());
        })),
        Box::new(move || {
            done.fetch_add(1, Ordering::SeqCst);
        }),
    ));
    World {
        migration,
        shown,
        finished,
    }
}

fn failure(check: &str) -> MigrationFailure {
    MigrationFailure {
        check: check.to_owned(),
        details: format!("{check} failed"),
    }
}

fn wait_for(migration: &Migration, state: MigrationState) -> MigrationStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = migration.status();
        if status.state == state {
            return status;
        }
        assert!(Instant::now() < deadline, "still {:?}", status.state);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_run_shows_every_update_in_order_then_done_and_resumes_the_boot_once() {
    let w = world(Script::new(vec![Ok(())]));
    assert_eq!(w.migration.status().state, MigrationState::Idle);
    assert!(w.migration.start());
    let done = wait_for(&w.migration, MigrationState::Done);
    assert_eq!(done.percent, 100);
    let shown = w.shown.lock().unwrap().clone();
    let seqs: Vec<u32> = shown.iter().map(|status| status.seq).collect();
    assert_eq!(
        seqs,
        [1, 2, 3, 4],
        "each change reaches the page once, in order"
    );
    let phases: Vec<Option<&str>> = shown.iter().map(|s| s.phase.as_deref()).collect();
    assert_eq!(
        phases,
        [
            Some("Preparing…"),
            Some("Moving your secrets…"),
            Some("Moving vault 1 of 2…"),
            None
        ]
    );
    assert_eq!(shown.last(), Some(&done));
    assert_eq!(w.finished.load(Ordering::SeqCst), 1);
    assert!(
        !w.migration.start(),
        "a finished migration does not run again"
    );
}

#[test]
fn a_failure_names_its_check_and_try_again_runs_the_import_again() {
    let script = Script::new(vec![Err(failure("check-3")), Ok(())]);
    let w = world(script.clone());
    assert!(w.migration.start());
    let failed = wait_for(&w.migration, MigrationState::Failed);
    assert_eq!(failed.check.as_deref(), Some("check-3"));
    assert_eq!(failed.check_line.as_deref(), Some("Failed check: check-3"));
    assert_eq!(failed.details.as_deref(), Some("check-3 failed"));
    assert_eq!(
        w.finished.load(Ordering::SeqCst),
        0,
        "the boot stays paused"
    );

    assert!(w.migration.start(), "Try again");
    wait_for(&w.migration, MigrationState::Done);
    assert_eq!(script.runs.load(Ordering::SeqCst), 2);
    assert_eq!(w.finished.load(Ordering::SeqCst), 1);
}

#[test]
fn try_again_while_a_run_is_going_starts_no_second_run() {
    let script = Script::new(vec![Ok(())]);
    let open = script.arm();
    let w = world(script.clone());
    assert!(w.migration.start());
    assert!(!w.migration.start());
    open.send(()).unwrap();
    wait_for(&w.migration, MigrationState::Done);
    assert_eq!(script.runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_panicking_import_fails_with_a_check_instead_of_hanging() {
    let w = world(Script::new(vec![Err(failure("panic!"))]));
    assert!(w.migration.start());
    let failed = wait_for(&w.migration, MigrationState::Failed);
    assert_eq!(failed.check.as_deref(), Some("panic"));
}

#[test]
fn the_update_script_cannot_close_a_script_tag() {
    let mut status = super::status::failed("en", &failure("x"));
    status.details = Some("</script><img src=x onerror=alert(1)>".to_owned());
    let script = update_script(&status);
    assert!(script.starts_with("window.memryMigration&&window.memryMigration.update({"));
    assert!(!script.contains("</script>"));
    assert!(script.contains(r"\u003c/script>"));
}
