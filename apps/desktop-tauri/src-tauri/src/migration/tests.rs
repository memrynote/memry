use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::electron_import::progress::{Phase, ProgressSink, ProgressUpdate};
use memry_desktop::locale::LocaleService;
use memry_desktop::registry::AppConfig;
use memry_desktop::telemetry::events::TelemetryEvent;
use memry_desktop::telemetry::service::Service;

use super::status::{MigrationState, MigrationStatus};
use super::{
    Backend, LazyTelemetry, Migration, MigrationFailure, TelemetrySink, locale_after_import,
    update_script,
};

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

    fn run(
        &self,
        progress: &dyn ProgressSink,
        telemetry: &dyn TelemetrySink,
    ) -> Result<(), MigrationFailure> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.gate.lock().unwrap().take() {
            gate.recv().unwrap();
        }
        telemetry.record(Service::event("migration_started", "app", "started"));
        for (phase, current, total) in [(Phase::Secrets, 1, 1), (Phase::Vault, 1, 2)] {
            progress.update(ProgressUpdate {
                phase,
                current,
                total,
                label: String::new(),
            });
        }
        let outcome = self.outcomes.lock().unwrap().remove(0);
        let end = if outcome.is_ok() {
            "completed"
        } else {
            "failed"
        };
        telemetry.record(Service::event(&format!("migration_{end}"), "app", end));
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

/// The events a run sent.
#[derive(Default)]
struct Sent(Mutex<Vec<String>>);

impl TelemetrySink for Sent {
    fn record(&self, event: TelemetryEvent) {
        self.0.lock().unwrap().push(event.name);
    }
}

struct World {
    migration: Arc<Migration>,
    shown: Arc<Mutex<Vec<MigrationStatus>>>,
    finished: Arc<AtomicU32>,
    sent: Arc<Sent>,
}

fn world(backend: Arc<Script>) -> World {
    let shown = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicU32::new(0));
    let (page, done) = (shown.clone(), finished.clone());
    let sent = Arc::new(Sent::default());
    let migration = Arc::new(Migration::new(
        backend,
        "en",
        std::path::Path::new("/data"),
        sent.clone(),
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
        sent,
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

/// A failed run never resumes the boot, so `Stage::Telemetry` never runs: the run's own sink
/// still carries `migration_failed`, and Try again gets the sink again.
#[test]
fn a_failed_run_still_sends_its_failure_and_try_again_reports_too() {
    let w = world(Script::new(vec![Err(failure("disk-space")), Ok(())]));
    assert!(w.migration.start());
    wait_for(&w.migration, MigrationState::Failed);
    assert_eq!(
        *w.sent.0.lock().unwrap(),
        ["migration_started", "migration_failed"]
    );
    assert!(w.migration.start());
    wait_for(&w.migration, MigrationState::Done);
    assert_eq!(
        w.sent.0.lock().unwrap()[2..],
        ["migration_started", "migration_completed"]
    );
}

/// Telemetry starts at the first event, after the import carried Electron's opt-out, and once.
#[test]
fn telemetry_starts_at_the_first_event_and_only_once() {
    let starts = Arc::new(AtomicU32::new(0));
    let counted = starts.clone();
    let sink = LazyTelemetry::new(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        None
    }));
    assert_eq!(
        starts.load(Ordering::SeqCst),
        0,
        "nothing starts before an event"
    );
    sink.record(Service::event("migration_started", "app", "started"));
    sink.record(Service::event("migration_failed", "app", "failed"));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

/// The `I18n` stage stored the OS language in the empty config; the import merged Electron's
/// over it, so the rest of the boot (menu, tray, main window) runs in Electron's language.
#[test]
fn after_the_import_the_boot_uses_the_imported_locale_not_the_os_one() {
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let os = || Some("ja-JP".to_owned());
    let live = LocaleService::new(crate::shell::services::boot_locale(&config, os));
    assert_eq!(live.get(), "ja", "first run adopts the OS language");

    config
        .update(|map| {
            map.insert("locale".to_owned(), "en".into());
            Ok::<_, memry_desktop::registry::ConfigError>(())
        })
        .unwrap();

    assert_eq!(locale_after_import(&config, &live, os), "en");
    assert_eq!(live.get(), "en");
}
