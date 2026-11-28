//! The session's open hook as the shell installs it ([`vault_migrator`], #3554 S1): a real
//! `Session` over a vault the first-launch run deferred.

use super::*;
use crate::session::StartupOutcome;

const AWAY_UUID: &str = "4a5b6c7d-0000-4000-8000-0000000000bb";

#[derive(Default)]
struct Shared(Mutex<Vec<MigrationEventName>>);

impl MigrationTelemetry for Shared {
    fn record(&self, event: MigrationEvent) {
        self.0.lock().unwrap().push(event.name);
    }
}

impl Shared {
    fn started(&self) -> usize {
        let names = self.0.lock().unwrap();
        names
            .iter()
            .filter(|n| **n == MigrationEventName::Started)
            .count()
    }
}

/// What the hook saw at each call: whether `.memry/core` existed.
type Calls = Arc<Mutex<Vec<bool>>>;

/// A session whose hook is the shell's [`vault_migrator`], wrapped only to record each call.
fn session(w: &World, telemetry: &Arc<Shared>) -> (Session, Calls) {
    let config = Arc::new(AppConfig::load(w.data.join("session-config.json")));
    let session = Session::new(VaultRegistry::new(config));
    let migrate = vault_migrator(w.ctx(None).env, w.data.clone(), telemetry.clone(), None);
    let calls = Calls::default();
    let seen = calls.clone();
    session.set_vault_migrator(Arc::new(move |path| {
        let core = path.join(".memry").join(vault_db::CORE_DIR);
        seen.lock().unwrap().push(core.exists());
        migrate(path)
    }));
    (session, calls)
}

/// Work imports at first launch; Away is missing then, so the run defers it.
fn deferred_world() -> World {
    let w = World::new(&[("Work", None), ("Away", Some(AWAY_UUID))]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.run().unwrap();
    assert_eq!(w.status("Away"), VaultStatus::Deferred);
    w
}

/// Red with no hook installed (or one installed after `prepare_core_dir`): Away opens with a
/// native core over Electron's data and its import never runs. Red with a hook that imports on
/// every open: `migration_started` is sent twice.
#[test]
fn an_open_imports_a_deferred_vault_once_before_its_core_exists() {
    let w = deferred_world();
    w.electron_vault("Away", None);
    let away = PathBuf::from(w.vault("Away"));
    let telemetry = Arc::new(Shared::default());
    let (session, calls) = session(&w, &telemetry);

    session.open(&away, OpenSource::Select).unwrap();
    session.close();

    assert_eq!(*calls.lock().unwrap(), [false], "one call, before the core");
    assert_eq!(telemetry.started(), 1);
    assert!(w.core_data("Away").is_file());
    assert_eq!(w.status("Away"), VaultStatus::Imported);

    session.open(&away, OpenSource::Select).unwrap();
    session.close();

    assert_eq!(calls.lock().unwrap().len(), 2);
    assert_eq!(telemetry.started(), 1, "the second open imports nothing");
    assert_eq!(w.status("Away"), VaultStatus::Imported);
}

/// A failed deferred import stops the open with the run's message, leaves the Electron vault
/// byte for byte as it was and creates no core; the next open tries again.
#[test]
fn a_failed_import_refuses_the_open_and_leaves_the_vault_untouched() {
    let w = deferred_world();
    let conn = w.electron_vault("Away", None);
    electron_db::seed(&conn, "reminders", &[]);
    drop(conn);
    let away = PathBuf::from(w.vault("Away"));
    let before = tree(&away);
    let telemetry = Arc::new(Shared::default());
    let (session, calls) = session(&w, &telemetry);

    let Err(SessionError::NotMigrated(message)) = session.open(&away, OpenSource::Select) else {
        panic!("opened over a failed import");
    };

    // The status the renderer reads names the failure.
    assert_eq!(session.status().error.as_deref(), Some(message.as_str()));
    assert!(!session.status().is_open);
    assert_eq!(tree(&away), before, "the Electron vault is untouched");
    assert!(!w.core_data("Away").parent().unwrap().exists(), "no core");
    let report = VerificationReport::parse(&fs::read(w.data.join(REPORT_FILE)).unwrap()).unwrap();
    assert!(
        report.failure.is_some(),
        "the report names the failing check"
    );
    let marker = w.marker().unwrap();
    let entry = marker.vaults.iter().find(|v| v.path == w.vault("Away"));
    assert_eq!(entry.map(|v| v.status), Some(VaultStatus::Deferred));

    let again = session.open(&away, OpenSource::Select);
    assert!(again.is_err());
    assert_eq!(calls.lock().unwrap().len(), 2, "every open asks again");
    assert_eq!(tree(&away), before);
}

/// Before the first-launch run finished, the hook refuses every vault of the Electron profile.
#[test]
fn an_open_before_the_first_launch_run_is_refused() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    let work = PathBuf::from(w.vault("Work"));
    let before = tree(&work);
    let telemetry = Arc::new(Shared::default());
    let (session, _) = session(&w, &telemetry);

    let Err(SessionError::NotMigrated(message)) = session.open(&work, OpenSource::Select) else {
        panic!("opened before the run");
    };

    assert!(
        message.contains("Finish moving your data first"),
        "{message}"
    );
    assert_eq!(tree(&work), before);
    assert!(!w.core_data("Work").exists());
}

/// A refusal is never a verdict on the vault (Electron still running, no disk space, a drive
/// away): the startup open keeps it current and the next launch tries it again. Red with the
/// refusal mapped to `SessionError::Invalid`, which `open_startup` treats as permanent.
#[test]
fn a_refused_startup_open_keeps_the_vault_current() {
    let w = deferred_world();
    let work = PathBuf::from(w.vault("Work"));
    let telemetry = Arc::new(Shared::default());
    let (session, _) = session(&w, &telemetry);
    session.open(&work, OpenSource::Select).unwrap();
    session.close();
    session.set_vault_migrator(Arc::new(|_| Err("electron is running".to_owned())));

    let outcome = session.open_startup(&crate::launch_env::LaunchEnv::default());

    let StartupOutcome::Failed { error, .. } = outcome else {
        panic!("opened");
    };
    assert!(matches!(error, SessionError::NotMigrated(_)), "{error}");
    assert_eq!(
        session.registry().current().as_deref(),
        Some(&*work.to_string_lossy())
    );
}
