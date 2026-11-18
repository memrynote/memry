//! The first-launch run over real Electron databases (`tests/support/electron_db.rs`), a real
//! `KeyringStore` on the in-memory test keychain and the Tauri data dir in a temp folder.

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::marker::{MARKER_FILE, Marker};
use super::*;
use crate::electron_import::progress::ProgressRecorder;
use crate::electron_import::secrets::{FixedKeySource, NoKeytar};
use crate::electron_import::{HostOs, vault_db};
use crate::registry::VaultRegistry;
use crate::seams::secure_store::tests::fake::{Rig, rig};
use crate::session::{OpenSource, Session, SessionError};

#[path = "../../../tests/support/electron_db.rs"]
#[allow(dead_code)]
mod electron_db;

#[derive(Default)]
struct Telemetry(Mutex<Vec<MigrationEvent>>);

impl MigrationTelemetry for Telemetry {
    fn record(&self, event: MigrationEvent) {
        self.0.lock().unwrap().push(event);
    }
}

impl Telemetry {
    fn names(&self) -> Vec<(MigrationEventName, Option<String>)> {
        let events = self.0.lock().unwrap();
        events
            .iter()
            .map(|e| (e.name, e.error_code.clone()))
            .collect()
    }
}

struct World {
    root: TempDir,
    profile: PathBuf,
    data: PathBuf,
    rig: Rig,
    identity: DeviceIdentityStore,
    app_config: AppConfig,
    progress: ProgressRecorder,
    telemetry: Telemetry,
}

fn no_space(_: &Path) -> std::io::Result<u64> {
    Ok(0)
}

impl World {
    /// An Electron profile whose config names `vaults` (`(name, vaultUuid)`), the first one
    /// current, and a Tauri data dir with nothing in it.
    fn new(vaults: &[(&str, Option<&str>)]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("electron").join("memrynote");
        let data = root.path().join("tauri");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&data).unwrap();
        let rig = rig();
        let identity = DeviceIdentityStore::with_probe(&rig.store, &data, || false);
        let world = Self {
            app_config: AppConfig::load(data.join("memry-config.json")),
            root,
            profile,
            data,
            rig,
            identity,
            progress: ProgressRecorder::default(),
            telemetry: Telemetry::default(),
        };
        let entries: Vec<Value> = vaults
            .iter()
            .map(|(name, uuid)| {
                let mut entry = json!({ "path": world.vault(name), "name": name });
                if let Some(uuid) = uuid {
                    entry["vaultUuid"] = json!(uuid);
                }
                entry
            })
            .collect();
        world.write_config(&json!({
            "vaults": entries,
            "currentVault": entries.first().map(|e| e["path"].clone()),
            "spellCheck": true,
            "sync": { "deviceId": "device-electron" },
        }));
        world
    }

    fn write_config(&self, config: &Value) {
        fs::write(
            self.profile.join("memry-config.json"),
            serde_json::to_vec(config).unwrap(),
        )
        .unwrap();
    }

    fn vault(&self, name: &str) -> String {
        self.root
            .path()
            .join("vaults")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    /// The vault folder with Electron's databases at the frozen schema, its singleton `uuid`.
    fn electron_vault(&self, name: &str, uuid: Option<&str>) -> Connection {
        let dir = PathBuf::from(self.vault(name));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("note.md"), "# A note\n").unwrap();
        let pair = electron_db::create_pair(&dir.join(".memry"));
        let conn = Connection::open(&pair.data).unwrap();
        if let Some(uuid) = uuid {
            electron_db::seed(
                &conn,
                "vault_metadata",
                &[
                    ("id", Sql::Text("singleton".into())),
                    ("vault_uuid", Sql::Text(uuid.into())),
                ],
            );
        }
        conn
    }

    fn ctx(&self, crash_after: Option<&str>) -> ImportContext<'_> {
        ImportContext {
            env: ProfileEnv {
                app_data: self.profile.parent().unwrap().to_owned(),
                override_dir: Some(self.profile.clone()),
                host: HostOs::current(),
            },
            tauri_data_dir: self.data.clone(),
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
                keyring: &self.rig.store,
                identity: &self.identity,
                key_source: &FixedKeySource::default(),
                keytar: &NoKeytar,
                secrets_mode: SecretsMode::Full,
            },
        )
    }

    fn run(&self) -> Result<FirstLaunch, RunError> {
        self.run_with(&self.ctx(None))
    }

    /// The report with this world's temp root written as `<root>`, to compare across worlds.
    fn report(&self) -> String {
        let text = fs::read_to_string(self.data.join(REPORT_FILE)).unwrap();
        text.replace(&*self.root.path().to_string_lossy(), "<root>")
    }

    fn spell_check(&self) -> Option<Value> {
        self.app_config.read(|map| map.get("spellCheck").cloned())
    }

    fn marker(&self) -> Option<Marker> {
        Marker::read(&self.data).unwrap()
    }

    fn core_data(&self, name: &str) -> PathBuf {
        Path::new(&self.vault(name))
            .join(".memry")
            .join(vault_db::CORE_DIR)
            .join("data.db")
    }

    fn status(&self, name: &str) -> VaultStatus {
        let report = VerificationReport::parse(&fs::read(self.data.join(REPORT_FILE)).unwrap());
        let report = report.unwrap();
        let path = self.vault(name);
        report
            .vaults
            .iter()
            .find(|v| v.path == path)
            .unwrap()
            .status
    }
}

/// path, size and bytes of every file under `dir`.
fn tree(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.map(Result::unwrap) {
        let path = entry.path();
        if path.is_dir() {
            out.extend(tree(&path));
        } else {
            out.push((path.clone(), fs::read(&path).unwrap()));
        }
    }
    out.sort();
    out
}

fn electron_files(w: &World, vaults: &[&str]) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = tree(&w.profile);
    for name in vaults {
        let memry = Path::new(&w.vault(name)).join(".memry");
        for file in [
            "data.db",
            "data.db-wal",
            "data.db-shm",
            "index.db",
            "index.db-wal",
        ] {
            if let Ok(bytes) = fs::read(memry.join(file)) {
                files.push((memry.join(file), bytes));
            }
        }
    }
    files
}

fn two_vault_world() -> World {
    let w = World::new(&[("Work", None), ("Home", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.electron_vault("Home", Some("4a5b6c7d-0000-4000-8000-000000000002"));
    w
}

#[test]
fn first_launch_imports_every_vault_and_writes_the_marker_last() {
    let w = two_vault_world();
    let before = electron_files(&w, &["Work", "Home"]);

    let FirstLaunch::Migrated(report) = w.run().unwrap() else {
        panic!("not migrated");
    };

    for name in ["Work", "Home"] {
        assert!(w.core_data(name).is_file(), "{name} imported");
        assert_eq!(w.status(name), VaultStatus::Imported);
    }
    assert_eq!(
        report.vaults[0].checks_passed,
        [1, 2, 3, 4, 5, 6, 7, 8],
        "every check passed"
    );
    assert_eq!(
        report.vaults[0].path,
        w.vault("Work"),
        "current vault first"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let core = w.core_data("Work").parent().unwrap().to_owned();
        assert_eq!(
            fs::metadata(core).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let marker = w.marker().unwrap();
    assert_eq!(marker.vaults.len(), 2);
    assert!(
        marker.vaults.iter().all(|v| v.source_fingerprint.is_some()),
        "the downgrade fingerprint of each imported vault"
    );
    assert_eq!(
        electron_files(&w, &["Work", "Home"]),
        before,
        "Electron data untouched"
    );
    assert!(!w.data.join(SCRATCH_DIR).exists());
    assert_eq!(
        w.telemetry.names(),
        [
            (MigrationEventName::Started, None),
            (MigrationEventName::Completed, None)
        ]
    );
    let phases: Vec<Phase> = w.progress.updates().iter().map(|u| u.phase).collect();
    let first = |p| phases.iter().position(|x| *x == p).unwrap();
    assert!(first(Phase::AppState) < first(Phase::Secrets));
    assert!(first(Phase::Secrets) < first(Phase::Vault));
    assert!(first(Phase::Vault) < first(Phase::Finish));

    let report_bytes = fs::read(w.data.join(REPORT_FILE)).unwrap();
    assert!(matches!(w.run().unwrap(), FirstLaunch::AlreadyDone));
    assert_eq!(fs::read(w.data.join(REPORT_FILE)).unwrap(), report_bytes);
}

#[test]
fn a_crash_after_any_phase_or_install_point_reruns_to_the_same_report() {
    let clean = two_vault_world();
    clean.run().unwrap();
    let expected = clean.report();
    let points = ["app-state", "secrets", "vault", "finish"].iter().chain(
        vault_db::crash::POINTS
            .iter()
            .filter(|p| !p.starts_with("native-first")),
    );
    for point in points {
        let w = two_vault_world();
        let crashed = catch_unwind(AssertUnwindSafe(|| w.run_with(&w.ctx(Some(point)))));
        assert!(crashed.is_err(), "{point} crashed");
        assert!(!w.data.join(MARKER_FILE).exists(), "{point}: no marker yet");
        assert!(
            matches!(w.run(), Ok(FirstLaunch::Migrated(_))),
            "{point}: rerun"
        );
        assert_eq!(w.report(), expected, "{point}: same report");
        assert!(w.marker().is_some(), "{point}: marker after the rerun");
    }
}

#[test]
fn a_resumed_run_keeps_what_the_user_changed_in_the_config() {
    let w = two_vault_world();
    let crashed = catch_unwind(AssertUnwindSafe(|| w.run_with(&w.ctx(Some("app-state")))));
    assert!(crashed.is_err());
    assert_eq!(w.spell_check(), Some(json!(true)));
    w.app_config
        .update(|map| {
            map.insert("spellCheck".into(), json!(false));
            Ok::<_, crate::registry::ConfigError>(())
        })
        .unwrap();

    w.run().unwrap();

    assert_eq!(w.spell_check(), Some(json!(false)));
}

#[test]
fn no_room_for_the_copies_stops_before_any_write() {
    let w = two_vault_world();
    let mut ctx = w.ctx(None);
    ctx.free_space = no_space;

    let error = w.run_with(&ctx).unwrap_err();

    assert!(matches!(error, RunError::DiskSpace { .. }), "{error}");
    assert_eq!(error.check(), "disk-space");
    assert!(w.marker().is_none());
    assert!(!w.core_data("Work").exists());
    assert_eq!(w.spell_check(), None, "app state not carried");
    assert!(
        w.telemetry.names().is_empty(),
        "no event before the opt-out is carried"
    );
}

#[test]
fn a_vault_at_another_electron_schema_stops_before_any_write() {
    let w = two_vault_world();
    let conn = Connection::open(Path::new(&w.vault("Home")).join(".memry/data.db")).unwrap();
    conn.execute(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?1)",
        [vault_db::tables::ELECTRON_DATA_LAST_MIGRATION + 1],
    )
    .unwrap();
    drop(conn);

    let error = w.run().unwrap_err();

    assert!(
        matches!(&error, RunError::ElectronSchema { vault, .. } if *vault == w.vault("Home")),
        "{error}"
    );
    assert!(w.marker().is_none());
    assert!(!w.core_data("Work").exists(), "nothing imported");
}

#[test]
fn not_ready_stops_the_whole_run() {
    let w = two_vault_world();
    let conn = Connection::open(Path::new(&w.vault("Home")).join(".memry/data.db")).unwrap();
    electron_db::seed(&conn, "attachment_files", &[]);
    drop(conn);

    let error = w.run().unwrap_err();

    assert_eq!(error.check(), "not-ready", "{error}");
    assert!(
        error.to_string().contains(&w.vault("Home")),
        "names the vault"
    );
    assert!(w.marker().is_none(), "no vault opens");
    assert!(!w.core_data("Home").exists());
    let report = VerificationReport::parse(&fs::read(w.data.join(REPORT_FILE)).unwrap()).unwrap();
    let failure = report.failure.unwrap();
    assert_eq!(failure.check, "not-ready");
    assert_eq!(failure.vault, Some(w.vault("Home")));
    assert_eq!(
        w.telemetry.names().last(),
        Some(&(MigrationEventName::Failed, Some("not-ready".into())))
    );
}

#[test]
fn vaults_sharing_a_store_are_deferred_and_never_open() {
    let w = World::new(&[("Original", None), ("Copy", None)]);
    let uuid = "4a5b6c7d-0000-4000-8000-0000000000aa";
    w.electron_vault("Original", Some(uuid));
    w.electron_vault("Copy", Some(uuid));

    w.run().unwrap();

    for name in ["Original", "Copy"] {
        assert_eq!(w.status(name), VaultStatus::Deferred);
        assert!(!w.core_data(name).exists());
    }
    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Copy"))).unwrap_err();
    let RunError::SharedStore { paths } = &error else {
        panic!("{error}");
    };
    assert_eq!(paths, &[w.vault("Copy"), w.vault("Original")]);
    assert!(!w.core_data("Copy").exists());
}

#[test]
fn one_folder_under_two_path_strings_imports_once() {
    let w = World::new(&[("Work", None)]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    let path = w.vault("Work");
    w.write_config(&json!({
        "vaults": [{ "path": path }, { "path": format!("{path}/") }],
        "currentVault": path,
    }));

    w.run().unwrap();

    let marker = w.marker().unwrap();
    let statuses: Vec<VaultStatus> = marker.vaults.iter().map(|v| v.status).collect();
    assert_eq!(statuses, [VaultStatus::Imported, VaultStatus::SameFolder]);
}

#[test]
fn a_deferred_vault_imports_when_first_opened() {
    let w = World::new(&[
        ("Work", None),
        ("Away", Some("4a5b6c7d-0000-4000-8000-0000000000bb")),
    ]);
    w.electron_vault("Work", Some("4a5b6c7d-0000-4000-8000-000000000001"));
    w.run().unwrap();
    assert_eq!(w.status("Away"), VaultStatus::Deferred);

    w.electron_vault("Away", None);
    migrate_vault(&w.ctx(None), Path::new(&w.vault("Away"))).unwrap();

    assert!(w.core_data("Away").is_file());
    assert_eq!(w.status("Away"), VaultStatus::Imported);
    let marker = w.marker().unwrap();
    let away = marker
        .vaults
        .iter()
        .find(|v| v.path == w.vault("Away"))
        .unwrap();
    assert_eq!(away.status, VaultStatus::Imported);
    assert_eq!(
        away.vault_uuid.as_deref(),
        Some("4a5b6c7d-0000-4000-8000-0000000000bb")
    );
}

/// A vault missing at first launch must not later fold the history of the vault that owns its
/// store (C2).
#[test]
fn a_deferred_vault_whose_store_was_imported_never_opens() {
    let uuid = "4a5b6c7d-0000-4000-8000-0000000000cc";
    let w = World::new(&[("Owner", None), ("Late", Some(uuid))]);
    w.electron_vault("Owner", Some(uuid));
    w.run().unwrap();
    assert_eq!(w.status("Owner"), VaultStatus::Imported);

    w.electron_vault("Late", None);
    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Late"))).unwrap_err();

    assert!(matches!(error, RunError::SharedStore { .. }), "{error}");
    assert!(!w.core_data("Late").exists());
    let error = migrate_vault(&w.ctx(None), Path::new(&w.vault("Late"))).unwrap_err();
    assert!(
        matches!(error, RunError::SharedStore { .. }),
        "refused again: {error}"
    );
}

#[test]
fn a_settled_vault_reads_only_the_marker() {
    let w = two_vault_world();
    let ctx = w.ctx(None);
    migrate_vault(&ctx, Path::new(&w.vault("Work"))).unwrap();
    assert!(!w.core_data("Work").exists(), "no marker: nothing to do");

    w.run().unwrap();
    fs::remove_dir_all(&w.profile).unwrap();

    migrate_vault(&ctx, Path::new(&w.vault("Work"))).unwrap();
    migrate_vault(&ctx, Path::new("/not/an/electron/vault")).unwrap();
}

#[test]
fn the_session_opens_no_vault_the_migrator_refuses() {
    let w = two_vault_world();
    let config = Arc::new(AppConfig::load(w.data.join("session-config.json")));
    let session = Session::new(VaultRegistry::new(config));
    session.set_vault_migrator(Arc::new(|_| Err("refused".to_owned())));

    let Err(error) = session.open(Path::new(&w.vault("Work")), OpenSource::Select) else {
        panic!("opened");
    };

    assert!(
        matches!(&error, SessionError::Invalid(m) if m == "refused"),
        "{error}"
    );
    assert!(
        !w.core_data("Work").parent().unwrap().exists(),
        "no .memry/core"
    );
}

#[test]
fn pending_notes_salvage_a_torn_write() {
    let w = World::new(&[]);
    let profile = crate::electron_import::profile::locate_profile(&w.ctx(None).env)
        .unwrap()
        .unwrap();
    assert!(vault::pending_notes(&profile).unwrap().is_empty());
    fs::write(w.profile.join("crdt-pending-notes.json"), r#"["a","b"]"#).unwrap();
    assert_eq!(vault::pending_notes(&profile).unwrap(), ["a", "b"]);
    fs::write(
        w.profile.join("crdt-pending-notes.json"),
        r#"["note-a","note-\"b","note-"#,
    )
    .unwrap();
    assert_eq!(
        vault::pending_notes(&profile).unwrap(),
        ["note-a", "note-\"b"]
    );
}
