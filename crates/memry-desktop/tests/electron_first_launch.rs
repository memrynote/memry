//! The first-launch migration (Step 37e2, #3554) over the Electron profile fixture (Step 37a):
//! a captured profile and its vault with Yjs stores and a bulk-apply journal, real SQLite, and
//! the secrets into keyring-core's in-memory mock. Its own binary: a crash point panics through
//! `catch_unwind` and arms Step 36's process-wide install hook.

#[path = "electron_profile/mod.rs"]
mod electron_profile;

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_desktop::electron_import::orchestrator::marker::Marker;
use memry_desktop::electron_import::orchestrator::{
    FirstLaunch, FirstLaunchInput, ImportContext, MigrationEvent, MigrationTelemetry, RunError,
    run_first_launch,
};
use memry_desktop::electron_import::progress::ProgressRecorder;
use memry_desktop::electron_import::report::{REPORT_FILE, VaultStatus, VerificationReport};
use memry_desktop::electron_import::secrets::NoKeytar;
use memry_desktop::electron_import::secrets_import::SecretsMode;
use memry_desktop::electron_import::vault_db::crash;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::{
    DEADLINE, DeviceIdentityStore, KeyringStore, Store, StoreFactory,
};
use tempfile::TempDir;

use crate::electron_profile::ElectronProfileFixture;

/// The OS credential store, as keyring-core's in-memory mock.
struct Mock(Store);

impl StoreFactory for Mock {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
struct Telemetry(Mutex<Vec<MigrationEvent>>);

impl MigrationTelemetry for Telemetry {
    fn record(&self, event: MigrationEvent) {
        self.0.lock().unwrap().push(event);
    }
}

/// The fixture installed, and a fresh Tauri data dir with its keychain.
struct Launch {
    fixture: ElectronProfileFixture,
    data_root: TempDir,
    keyring: Arc<KeyringStore>,
    identity: DeviceIdentityStore,
    app_config: AppConfig,
    progress: ProgressRecorder,
    telemetry: Telemetry,
}

impl Launch {
    /// The fixture as captured: its vault has a sync cursor, which Step 36 refuses until 36c3.
    fn new() -> Self {
        Self::with(ElectronProfileFixture::install())
    }

    /// The fixture's vault as a never-synced vault of notes only: without the rows of the tables
    /// Step 36 does not import yet (`TABLE_MAP` `Pending`: 36b, 36c2, 36c3, 36d1, 36d2), so it
    /// stages. Its Yjs stores, journal and note tables are the captured ones.
    fn notes_only() -> Self {
        let fixture = ElectronProfileFixture::install();
        let conn = rusqlite::Connection::open(fixture.data_db()).unwrap();
        conn.execute_batch(
            "DELETE FROM sync_state WHERE key = 'lastCursor';
             DELETE FROM inbox_items; DELETE FROM projects; DELETE FROM tasks;
             DELETE FROM settings; DELETE FROM sync_pending_deletes;
             DELETE FROM sync_queue WHERE type IN ('task', 'project', 'inbox', 'settings');",
        )
        .unwrap();
        drop(conn);
        Self::with(fixture)
    }

    fn with(fixture: ElectronProfileFixture) -> Self {
        let data_root = tempfile::tempdir().unwrap();
        let keyring = Arc::new(KeyringStore::with_factory(
            Mock(keyring_core::mock::Store::new().unwrap()),
            None,
            DEADLINE,
        ));
        let identity = DeviceIdentityStore::with_probe(&keyring, data_root.path(), || false);
        Self {
            app_config: AppConfig::load(data_root.path().join("memry-config.json")),
            fixture,
            data_root,
            keyring,
            identity,
            progress: ProgressRecorder::default(),
            telemetry: Telemetry::default(),
        }
    }

    fn data(&self) -> PathBuf {
        self.data_root.path().to_owned()
    }

    fn ctx(&self, crash_after: Option<&str>) -> ImportContext<'_> {
        ImportContext {
            env: self.fixture.profile_env(),
            tauri_data_dir: self.data(),
            progress: &self.progress,
            telemetry: &self.telemetry,
            crash_after: crash_after.map(str::to_owned),
            now_ms: || 1_800_000_000_000,
            free_space: |_| Ok(u64::MAX),
        }
    }

    fn run_with(&self, ctx: &ImportContext<'_>) -> Result<FirstLaunch, RunError> {
        run_first_launch(
            ctx,
            &FirstLaunchInput {
                app_config: &self.app_config,
                keyring: &self.keyring,
                identity: &self.identity,
                key_source: &self.fixture.key_source(),
                keytar: &NoKeytar,
                // The capture stores the sync tokens as plain strings, where Electron's
                // `storeToken` writes base64 (`token-manager.ts`), so Full refuses them as
                // malformed. Sign in again skips the sync secrets; the vault path is the same.
                secrets_mode: SecretsMode::SignInAgain,
            },
        )
    }

    fn run(&self) -> Result<FirstLaunch, RunError> {
        self.run_with(&self.ctx(None))
    }

    /// The saved report with this launch's temp roots replaced, to compare across launches.
    fn report(&self) -> String {
        let text = fs::read_to_string(self.data().join(REPORT_FILE)).unwrap();
        let fixture_root = self.fixture.profile.parent().unwrap().parent().unwrap();
        text.replace(&*fixture_root.to_string_lossy(), "<fixture>")
            .replace(&*self.data().to_string_lossy(), "<data>")
    }

    fn core_data(&self) -> PathBuf {
        self.fixture.vault.join(".memry/core/data.db")
    }
}

/// Check 3 compares the six folded note documents with the staged ones and check 7 the vault
/// tree around the journal replay's two writes, so neither is vacuous here.
#[test]
fn the_fixture_profile_migrates_with_every_check_green() {
    let launch = Launch::notes_only();
    let before = launch.fixture.snapshot();

    let report = match launch.run() {
        Ok(FirstLaunch::Migrated(report)) => report,
        other => panic!("not migrated: {other:?}"),
    };

    let vault = &report.vaults[0];
    assert_eq!(vault.path, launch.fixture.vault.to_string_lossy());
    assert_eq!(vault.status, VaultStatus::Imported);
    assert_eq!(vault.checks_passed, [1, 2, 3, 4, 5, 6, 7, 8]);
    let prep = vault.prep.as_ref().unwrap();
    assert_eq!(prep["fold"]["docs"], 6, "documents check 3 compared");
    assert_eq!(
        prep["replay"]["written"].as_array().unwrap().len(),
        2,
        "journal replayed"
    );
    // C9/C11: what the fold and the replay left out, by count or entry.
    for key in [
        "skipped",
        "incomplete",
        "tornTails",
        "ignoredKeys",
        "legacy",
        "owedCompactions",
    ] {
        assert!(prep["fold"].get(key).is_some(), "fold.{key}");
    }
    for key in ["skipped", "otherVault", "unknown"] {
        assert!(prep["replay"].get(key).is_some(), "replay.{key}");
    }
    assert!(launch.core_data().is_file());
    assert_eq!(launch.fixture.snapshot(), before, "Electron data untouched");
    assert!(Marker::read(&launch.data()).unwrap().is_some());
    let saved = fs::read(launch.data().join(REPORT_FILE)).unwrap();
    assert!(matches!(launch.run().unwrap(), FirstLaunch::AlreadyDone));
    assert_eq!(
        fs::read(launch.data().join(REPORT_FILE)).unwrap(),
        saved,
        "second run no-op"
    );
}

/// The captured vault has a sync cursor and task, inbox and settings rows, which Step 36
/// refuses until its 36b/c2/c3/d1/d2 stages: the whole run stops there (Kaan, #3554 Q3), after
/// the replay and fold were reported, and no vault opens.
#[test]
fn the_captured_vault_stops_the_run_at_not_ready() {
    let launch = Launch::new();
    let before = launch.fixture.snapshot();

    let error = launch.run().unwrap_err();

    assert_eq!(error.check(), "not-ready", "{error}");
    assert!(Marker::read(&launch.data()).unwrap().is_none());
    assert!(!launch.core_data().exists());
    let report =
        VerificationReport::parse(&fs::read(launch.data().join(REPORT_FILE)).unwrap()).unwrap();
    assert_eq!(report.failure.unwrap().check, "not-ready");
    assert_eq!(report.vaults[0].status, VaultStatus::Prepared);
    assert_eq!(launch.fixture.snapshot(), before, "Electron data untouched");
}

#[test]
fn a_crash_at_any_point_reruns_to_the_report_of_an_uninterrupted_run() {
    let clean = Launch::notes_only();
    clean.run().unwrap();
    let expected = clean.report();
    let points = ["app-state", "secrets", "vault", "finish"].iter().chain(
        crash::POINTS
            .iter()
            .filter(|p| !p.starts_with("native-first")),
    );
    for point in points {
        let launch = Launch::notes_only();
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            launch.run_with(&launch.ctx(Some(point)))
        }));
        assert!(crashed.is_err(), "{point} crashed");
        assert!(
            Marker::read(&launch.data()).unwrap().is_none(),
            "{point}: no marker"
        );
        assert!(
            matches!(launch.run(), Ok(FirstLaunch::Migrated(_))),
            "{point}: rerun"
        );
        assert_eq!(launch.report(), expected, "{point}: same report");
    }
}
