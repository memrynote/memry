//! The Electron vault import (Step 36, #3553) over real SQLite files built by
//! `support/electron_db.rs`: refusals before any write, the Electron files left byte for byte,
//! `AlreadyImported` and `NativeFirst`, and a crash at every named point followed by a rerun.
//! Its own binary: the crash points panic through `catch_unwind`, and the feature that arms
//! them (`import-crash-points`) is on for this crate's tests only.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use memry_core::storage::import::{DATA_FILE, INDEX_FILE, read_marker};
use memry_desktop::electron_import::vault_db::{
    CORE_DIR, STAGING_DIR, StageOutcome, VaultImportInput, VaultStageReport, crash,
    stage_vault_import,
};
use memry_desktop::electron_import::{
    AppNameCandidates, ElectronProfile, HostOs, ImportError, ProfileLock,
};
use rusqlite::Connection;
use rusqlite::types::Value;
use sha2::{Digest, Sha256};

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "electron_vault_import/docs.rs"]
mod docs;
#[path = "support/electron_db.rs"]
mod electron_db;
#[path = "electron_vault_import/notes.rs"]
mod notes;
#[path = "electron_vault_import/queue.rs"]
mod queue;
#[path = "electron_vault_import/queue_deletes.rs"]
mod queue_deletes;
#[path = "electron_vault_import/records.rs"]
mod records;
#[path = "electron_vault_import/settle.rs"]
mod settle;
#[path = "electron_vault_import/tag_template_records.rs"]
mod tag_template_records;
#[path = "vault_env/mod.rs"]
mod vault_env;

const NOW_MS: i64 = 1_800_000_000_000;
const ELECTRON_DEVICE: &str = "device-electron";

struct Vault {
    _dir: tempfile::TempDir,
    root: PathBuf,
    pair: electron_db::ElectronPair,
    profile: ElectronProfile,
    lock: ProfileLock,
    /// `memry-config.json` `sync.deviceId`.
    device_id: Option<&'static str>,
}

/// An Electron profile whose localStorage store has a free LOCK file.
fn electron_profile(dir: &Path) -> ElectronProfile {
    let profile = ElectronProfile {
        dir: dir.join("electron-profile"),
        host: HostOs::current(),
        pin: None,
        app_names: AppNameCandidates(Vec::new()),
        has_config: false,
        has_secure_store: false,
        has_local_state: false,
        has_local_storage: true,
        has_legacy_crdt_store: false,
        has_custom_dictionary: false,
        crdt_store_dirs: Vec::new(),
        other_candidates: Vec::new(),
    };
    std::fs::create_dir_all(profile.local_storage_dir()).unwrap();
    std::fs::write(profile.local_storage_dir().join("LOCK"), b"").unwrap();
    profile
}

impl Vault {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let pair = electron_db::create_pair(&root.join(".memry"));
        let profile = electron_profile(dir.path());
        let lock = ProfileLock::probe(&profile).unwrap();
        Self {
            _dir: dir,
            root,
            pair,
            profile,
            lock,
            device_id: Some(ELECTRON_DEVICE),
        }
    }

    fn input(&self) -> VaultImportInput<'_> {
        VaultImportInput {
            electron_closed: &self.lock,
            vault_dir: self.root.clone(),
            vault_id: "vault-1".into(),
            electron_data_db: self.pair.data.clone(),
            electron_index_db: self.pair.index.clone(),
            docs: Vec::new(),
            extra_owed_docs: Vec::new(),
            vault_key: None,
            electron_device_id: self.device_id.map(str::to_owned),
            now_ms: NOW_MS,
            progress: None,
        }
    }

    fn core(&self) -> PathBuf {
        self.root.join(".memry").join(CORE_DIR)
    }

    fn staging(&self) -> PathBuf {
        self.root.join(".memry").join(STAGING_DIR)
    }

    fn data_conn(&self) -> Connection {
        Connection::open(&self.pair.data).unwrap()
    }
}

fn staged(outcome: StageOutcome) -> memry_desktop::electron_import::vault_db::StagedVault {
    match outcome {
        StageOutcome::Staged(staged) => staged,
        StageOutcome::AlreadyImported => panic!("AlreadyImported"),
        StageOutcome::NativeFirst => panic!("NativeFirst"),
    }
}

/// Stages and installs; returns the report.
fn import(vault: &Vault) -> VaultStageReport {
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    let report = staged.report().clone();
    staged.install().unwrap();
    report
}

/// sha256 of the Electron database and every sidecar beside it, by suffix.
fn electron_hashes(db: &Path) -> BTreeMap<&'static str, String> {
    let mut hashes = BTreeMap::new();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = PathBuf::from(format!("{}{suffix}", db.display()));
        if let Ok(bytes) = std::fs::read(&path) {
            hashes.insert(suffix, hex::encode(Sha256::digest(&bytes)));
        }
    }
    hashes
}

/// Every file and directory under `.memry/` other than the Electron pair and its sidecars.
fn written_by_import(vault: &Vault) -> Vec<String> {
    let memry = vault.root.join(".memry");
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&memry).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !(name.starts_with("data.db") || name.starts_with("index.db")) {
            found.push(name);
        }
    }
    found.sort();
    found
}

fn installed_marker(vault: &Vault) -> Option<String> {
    read_marker(&vault.core().join(DATA_FILE)).unwrap()
}

#[test]
fn an_empty_electron_pair_installs_a_core_pair_that_opens() {
    let vault = Vault::new();
    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert!(report.tables.values().all(|t| t.source_count == 0));
    assert!(!vault.staging().exists(), "staging removed after install");

    let marker: serde_json::Value =
        serde_json::from_str(&installed_marker(&vault).unwrap()).unwrap();
    assert_eq!(marker["version"], 1);
    assert_eq!(marker["importedAt"], NOW_MS);
    assert!(!marker["pending"].as_array().unwrap().is_empty());

    for name in [DATA_FILE, INDEX_FILE] {
        let conn = Connection::open(vault.core().join(name)).unwrap();
        let ledger: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!ledger, "{name} carries no drizzle ledger");
    }
    // The installed data.db is a core database: the drizzle guard lets it open, in WAL again.
    let db = memry_core::storage::open_data(&vault.core().join(DATA_FILE)).unwrap();
    drop(db);
    let mode: String = Connection::open(vault.core().join(DATA_FILE))
        .unwrap()
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

/// The Electron files, the WAL of a still-open Electron writer and its `-shm` included, hash
/// the same before staging and after install.
#[test]
fn the_electron_files_are_never_written() {
    let vault = Vault::new();
    let writer = electron_db::open_without_checkpoints(&vault.pair.data);
    // A skip table: rows the import drops by rule, so the run gets past the preflight.
    electron_db::seed(&writer, "sync_devices", &[]);
    let before = (
        electron_hashes(&vault.pair.data),
        electron_hashes(&vault.pair.index),
    );
    assert!(before.0.contains_key("-wal") && before.0.contains_key("-shm"));

    let report = import(&vault);
    assert_eq!(report.tables["data.db/sync_devices"].source_count, 1);
    assert_eq!(report.tables["data.db/sync_devices"].dropped, 1);
    assert_eq!(
        (
            electron_hashes(&vault.pair.data),
            electron_hashes(&vault.pair.index)
        ),
        before
    );
    drop(writer);
}

#[cfg(unix)]
#[test]
fn staging_and_core_share_one_file_system() {
    use std::os::unix::fs::MetadataExt;
    let vault = Vault::new();
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    let staging_dev = std::fs::metadata(vault.staging()).unwrap().dev();
    let memry_dev = std::fs::metadata(vault.root.join(".memry")).unwrap().dev();
    assert_eq!(staging_dev, memry_dev);
    assert_eq!(vault.staging().parent(), vault.core().parent());
    staged.discard().unwrap();
    assert!(!vault.staging().exists());
    assert!(!vault.core().exists());
}

/// Each refusal fails before any core file exists and leaves no staging directory.
fn assert_refused(vault: &Vault, check: impl Fn(&ImportError) -> bool) {
    let before = (
        electron_hashes(&vault.pair.data),
        electron_hashes(&vault.pair.index),
    );
    let error = match stage_vault_import(vault.input()) {
        Err(error) => error,
        Ok(_) => panic!("the import was not refused"),
    };
    assert!(check(&error), "{error}");
    assert_eq!(written_by_import(vault), Vec::<String>::new());
    assert_eq!(
        (
            electron_hashes(&vault.pair.data),
            electron_hashes(&vault.pair.index)
        ),
        before
    );
}

#[test]
fn an_unmapped_table_aborts_before_any_write() {
    let vault = Vault::new();
    vault
        .data_conn()
        .execute_batch("CREATE TABLE from_a_newer_electron (id TEXT)")
        .unwrap();
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::UnmappedTable { db: "data.db", table } if table == "from_a_newer_electron"),
    );
}

#[test]
fn an_unmapped_sync_state_key_aborts_before_any_write() {
    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "sync_state",
        &[("key", Value::Text("fromANewerElectron".into()))],
    );
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::UnmappedSyncStateKey(key) if key == "fromANewerElectron"),
    );
}

#[test]
fn rows_whose_importer_is_pending_abort_before_any_write() {
    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "settings",
        &[("key", Value::Text("theme".into()))],
    );
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::NotReady { detail, .. } if detail.contains("data.db/settings")),
    );

    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "sync_state",
        &[("key", Value::Text("lastCursor".into()))],
    );
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::NotReady { detail, .. } if detail.contains("lastCursor")),
    );
}

#[test]
fn a_source_at_another_migration_aborts_before_any_write() {
    let vault = Vault::new();
    vault
        .data_conn()
        .execute_batch(
            "DELETE FROM __drizzle_migrations
             WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
        )
        .unwrap();
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::SourceSchema {
                db: "data.db",
                found: Some(_),
                ..
            }
        )
    });
}

#[test]
fn a_vault_already_imported_is_reported_and_left_alone() {
    let vault = Vault::new();
    import(&vault);
    let before = std::fs::read(vault.core().join(DATA_FILE)).unwrap();
    std::fs::create_dir_all(vault.staging()).unwrap();
    assert!(matches!(
        stage_vault_import(vault.input()).unwrap(),
        StageOutcome::AlreadyImported
    ));
    assert_eq!(std::fs::read(vault.core().join(DATA_FILE)).unwrap(), before);
    assert!(
        !vault.staging().exists(),
        "a leftover staging directory is removed"
    );
}

#[test]
fn a_vault_first_opened_natively_is_never_replaced() {
    let vault = Vault::new();
    std::fs::create_dir_all(vault.core()).unwrap();
    drop(memry_core::storage::open_data(&vault.core().join(DATA_FILE)).unwrap());
    let before = std::fs::read(vault.core().join(DATA_FILE)).unwrap();
    assert!(matches!(
        stage_vault_import(vault.input()).unwrap(),
        StageOutcome::NativeFirst
    ));
    assert_eq!(std::fs::read(vault.core().join(DATA_FILE)).unwrap(), before);
    assert_eq!(installed_marker(&vault), None);
}

/// A native core that crashed with its last writes still in the WAL: the WAL is never deleted.
#[test]
fn a_core_wal_without_its_database_is_refused() {
    let vault = Vault::new();
    std::fs::create_dir_all(vault.core()).unwrap();
    let wal = vault.core().join(format!("{DATA_FILE}-wal"));
    std::fs::write(&wal, b"native writes").unwrap();
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::CoreFileExists(path)) if path == wal
    ));
    assert_eq!(std::fs::read(&wal).unwrap(), b"native writes");
}

/// A crash at each named point, then a plain rerun: the rerun installs the same pair a run
/// with no crash installs, and no staging directory is left.
#[test]
fn a_crash_at_any_point_then_a_rerun_installs_the_same_import() {
    let clean = Vault::new();
    let clean_report = import(&clean);
    let clean_marker = installed_marker(&clean).unwrap();

    // A `native-first:` point fires only on a rerun of a cut-off install (its own test).
    for point in crash::POINTS
        .iter()
        .filter(|p| !p.starts_with("native-first:"))
    {
        let vault = Vault::new();
        crash::arm(point);
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let staged = staged(stage_vault_import(vault.input()).unwrap());
            staged.install().unwrap();
        }));
        assert!(crashed.is_err(), "{point} did not fire");

        match stage_vault_import(vault.input()).unwrap() {
            StageOutcome::Staged(staged) => {
                assert_ne!(*point, "install:data-renamed", "the data.db rename commits");
                assert_eq!(staged.report(), &clean_report, "{point}");
                staged.install().unwrap();
            }
            StageOutcome::AlreadyImported => assert_eq!(*point, "install:data-renamed"),
            StageOutcome::NativeFirst => panic!("{point}: rerun read the import as native"),
        }
        assert_eq!(
            installed_marker(&vault).as_deref(),
            Some(clean_marker.as_str()),
            "{point}"
        );
        assert!(vault.core().join(INDEX_FILE).exists(), "{point}");
        assert!(!vault.staging().exists(), "{point}: staging left behind");
    }
}

/// `core/index.db` left by a run cut off between the two renames is replaced by the rerun's.
#[test]
fn an_index_without_its_data_db_is_replaced() {
    let vault = Vault::new();
    std::fs::create_dir_all(vault.core()).unwrap();
    std::fs::write(vault.core().join(INDEX_FILE), b"stale index").unwrap();
    std::fs::write(vault.core().join(format!("{INDEX_FILE}-wal")), b"stale").unwrap();
    import(&vault);
    assert_ne!(
        std::fs::read(vault.core().join(INDEX_FILE)).unwrap(),
        b"stale index"
    );
    assert!(!vault.core().join(format!("{INDEX_FILE}-wal")).exists());
}

/// A vault opened natively between stage and install: install refuses before it removes or
/// renames anything, so the native pair (index.db included) is left byte for byte.
#[test]
fn install_refuses_before_touching_a_native_pair() {
    for native in [DATA_FILE.to_owned(), format!("{DATA_FILE}-wal")] {
        let vault = Vault::new();
        let staged = staged(stage_vault_import(vault.input()).unwrap());
        std::fs::create_dir_all(vault.core()).unwrap();
        let native_path = vault.core().join(&native);
        std::fs::write(&native_path, b"native data").unwrap();
        std::fs::write(vault.core().join(INDEX_FILE), b"native index").unwrap();
        std::fs::write(
            vault.core().join(format!("{INDEX_FILE}-wal")),
            b"native wal",
        )
        .unwrap();

        assert!(
            matches!(staged.install(), Err(ImportError::CoreFileExists(path)) if path == native_path),
            "{native}"
        );
        assert_eq!(std::fs::read(&native_path).unwrap(), b"native data");
        assert_eq!(
            std::fs::read(vault.core().join(INDEX_FILE)).unwrap(),
            b"native index",
            "{native}"
        );
        assert_eq!(
            std::fs::read(vault.core().join(format!("{INDEX_FILE}-wal"))).unwrap(),
            b"native wal"
        );
    }
}

/// A `core/data.db` that is a dangling symlink is a file the import must not replace, not an
/// absent one.
#[cfg(unix)]
#[test]
fn a_dangling_core_symlink_is_refused() {
    let vault = Vault::new();
    std::fs::create_dir_all(vault.core()).unwrap();
    let data = vault.core().join(DATA_FILE);
    std::os::unix::fs::symlink(vault.root.join("elsewhere.db"), &data).unwrap();
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::CoreFileExists(path)) if path == data
    ));
    assert!(!vault.root.join("elsewhere.db").exists());
    assert!(!vault.staging().exists());
}

/// Holds the LOCK file the way a running Electron's LevelDB does, until dropped.
struct ElectronRunning {
    #[cfg(unix)]
    holder: std::process::Child,
    #[cfg(windows)]
    _held: std::fs::File,
}

impl ElectronRunning {
    #[cfg(unix)]
    fn start(lock: &Path) -> Self {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        // LevelDB holds an fcntl write lock, which is per process, so another process holds it
        // here; python's lockf is the same primitive.
        let mut holder = Command::new("python3")
            .args([
                "-c",
                "import fcntl,sys,time\nf=open(sys.argv[1],'r+')\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\ntime.sleep(60)",
            ])
            .arg(lock)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(holder.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "locked");
        Self { holder }
    }

    #[cfg(windows)]
    fn start(lock: &Path) -> Self {
        use std::os::windows::fs::OpenOptionsExt;
        // LevelDB opens its LOCK with share mode 0 on Windows.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(lock)
            .unwrap();
        Self { _held: held }
    }
}

#[cfg(unix)]
impl Drop for ElectronRunning {
    fn drop(&mut self) {
        let _ = self.holder.kill();
        let _ = self.holder.wait();
    }
}

/// Electron started after the caller's probe: the run never returns `Staged`, writes no core
/// file and leaves no staging directory, and succeeds once Electron has quit.
#[test]
fn a_run_while_electron_runs_is_never_staged() {
    let vault = Vault::new();
    let running = ElectronRunning::start(&vault.profile.local_storage_dir().join("LOCK"));
    let outcome = stage_vault_import(vault.input());
    drop(running);
    assert!(
        matches!(outcome, Err(ImportError::ProfileInUse(_))),
        "{:?}",
        outcome.as_ref().err()
    );
    assert!(!vault.staging().exists());
    assert!(!vault.core().exists());
    import(&vault);
}

/// Electron started after the copy and before the run returns: the last probe catches it, so the
/// run writes no core file and leaves no staging directory.
#[test]
fn electron_started_after_the_copy_fails_the_last_probe() {
    let vault = Vault::new();
    let running = std::rc::Rc::new(std::cell::RefCell::new(None));
    let holder = running.clone();
    let lock = vault.profile.local_storage_dir().join("LOCK");
    crash::hook("stage:writer-created", move || {
        *holder.borrow_mut() = Some(ElectronRunning::start(&lock));
    });
    let outcome = stage_vault_import(vault.input());
    assert!(running.borrow_mut().take().is_some(), "the hook ran");
    assert!(
        matches!(outcome, Err(ImportError::ProfileInUse(_))),
        "{:?}",
        outcome.as_ref().err()
    );
    assert!(!vault.staging().exists());
    assert!(!vault.core().exists());
}

/// `core/` the way a native recovery leaves it between moving `data.db` aside and opening the
/// fresh one: the quarantine, the marker naming it, the native `index.db`, and no `data.db`.
fn native_core_mid_recovery(vault: &Vault) {
    let core = vault.core();
    std::fs::create_dir_all(&core).unwrap();
    let data = core.join(DATA_FILE);
    drop(memry_core::storage::open_data(&data).unwrap());
    let quarantined = core.join(format!("{DATA_FILE}.corrupt-1700000000000"));
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", data.display()));
        if from.exists() {
            std::fs::rename(&from, format!("{}{suffix}", quarantined.display())).unwrap();
        }
    }
    std::fs::write(
        core.join(format!("{DATA_FILE}.recovering")),
        quarantined.display().to_string(),
    )
    .unwrap();
    std::fs::write(core.join(INDEX_FILE), b"native index").unwrap();
}

/// A native core whose recovery has moved `data.db` aside and not yet opened the fresh one is a
/// native core: install refuses it, and the next run reads it as `NativeFirst`.
#[test]
fn a_native_core_mid_recovery_is_never_replaced() {
    let vault = Vault::new();
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    native_core_mid_recovery(&vault);
    let marker = vault.core().join(format!("{DATA_FILE}.recovering"));
    assert!(matches!(
        staged.install(),
        Err(ImportError::CoreFileExists(path)) if path == marker
    ));
    assert_eq!(
        std::fs::read(vault.core().join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert!(!vault.core().join(DATA_FILE).exists());

    assert!(matches!(
        stage_vault_import(vault.input()).unwrap(),
        StageOutcome::NativeFirst
    ));
    assert_eq!(
        std::fs::read(vault.core().join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert!(!vault.core().join(DATA_FILE).exists());
    assert!(!vault.staging().exists());
}

/// A native open while install fsyncs the staged pair: the guard runs after the fsyncs, right
/// before the first change under `core/`, so the native pair is left byte for byte.
#[test]
fn install_refuses_a_native_open_during_its_fsyncs() {
    let vault = Vault::new();
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    let core = vault.core();
    crash::hook("install:synced", move || {
        std::fs::write(core.join(DATA_FILE), b"native data").unwrap();
        std::fs::write(core.join(INDEX_FILE), b"native index").unwrap();
    });
    let data = vault.core().join(DATA_FILE);
    assert!(matches!(
        staged.install(),
        Err(ImportError::CoreFileExists(path)) if path == data
    ));
    assert_eq!(std::fs::read(&data).unwrap(), b"native data");
    assert_eq!(
        std::fs::read(vault.core().join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert!(!vault.staging().join("replaced-index").exists());
}

/// A native `data.db` that appears after the index rename: the `data.db` rename refuses, and the
/// `index.db` that was in `core/` before the install is put back with its sidecar.
#[test]
fn a_refused_data_rename_puts_the_previous_index_back() {
    let vault = Vault::new();
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    let core = vault.core();
    std::fs::create_dir_all(&core).unwrap();
    let index_wal = core.join(format!("{INDEX_FILE}-wal"));
    std::fs::write(core.join(INDEX_FILE), b"native index").unwrap();
    std::fs::write(&index_wal, b"native wal").unwrap();
    let hooked = core.clone();
    crash::hook("install:index-renamed", move || {
        std::fs::write(hooked.join(DATA_FILE), b"native data").unwrap();
        std::fs::write(hooked.join(format!("{INDEX_FILE}-wal")), b"foreign wal").unwrap();
    });
    let data = core.join(DATA_FILE);
    assert!(matches!(
        staged.install(),
        Err(ImportError::CoreFileExists(path)) if path == data
    ));
    assert_eq!(std::fs::read(&data).unwrap(), b"native data");
    assert_eq!(
        std::fs::read(core.join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert_eq!(std::fs::read(&index_wal).unwrap(), b"native wal");
}

/// A run cut off between the two renames, then a native open, then a rerun: the rerun reads
/// `NativeFirst` and puts the `index.db` the install replaced back beside the native `data.db`.
#[test]
fn a_native_open_after_a_cut_off_install_gets_its_index_back() {
    let vault = Vault::new();
    let core = vault.core();
    std::fs::create_dir_all(&core).unwrap();
    let index_wal = core.join(format!("{INDEX_FILE}-wal"));
    std::fs::write(core.join(INDEX_FILE), b"native index").unwrap();
    std::fs::write(&index_wal, b"native wal").unwrap();
    crash::arm("install:index-renamed");
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        staged(stage_vault_import(vault.input()).unwrap())
            .install()
            .unwrap();
    }));
    assert!(crashed.is_err());
    drop(memry_core::storage::open_data(&core.join(DATA_FILE)).unwrap());

    assert!(matches!(
        stage_vault_import(vault.input()).unwrap(),
        StageOutcome::NativeFirst
    ));
    assert_eq!(
        std::fs::read(core.join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert_eq!(std::fs::read(&index_wal).unwrap(), b"native wal");
    assert!(!vault.staging().exists());
}

/// A recovery marker naming no quarantine file: the run stops before it stages anything.
#[test]
fn a_stale_recovery_marker_stops_before_staging() {
    let vault = Vault::new();
    std::fs::create_dir_all(vault.core()).unwrap();
    let marker = vault.core().join(format!("{DATA_FILE}.recovering"));
    std::fs::write(&marker, vault.core().join("gone.db").display().to_string()).unwrap();
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::CoreFileExists(path)) if path == marker
    ));
    assert!(!vault.staging().exists());
}

/// A rerun that reads `NativeFirst` and is itself cut off between taking the imported index out
/// of `core/` and putting the replaced one back, then a native open that creates a fresh
/// `core/index.db`: the next rerun still puts the replaced index back.
#[test]
fn a_cut_off_index_take_back_is_finished_by_the_next_rerun() {
    let vault = Vault::new();
    let core = vault.core();
    std::fs::create_dir_all(&core).unwrap();
    std::fs::write(core.join(INDEX_FILE), b"native index").unwrap();
    crash::arm("install:index-renamed");
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        staged(stage_vault_import(vault.input()).unwrap())
            .install()
            .unwrap();
    }));
    assert!(crashed.is_err());
    drop(memry_core::storage::open_data(&core.join(DATA_FILE)).unwrap());

    crash::arm("native-first:index-taken-out");
    assert!(catch_unwind(AssertUnwindSafe(|| stage_vault_import(vault.input()))).is_err());
    std::fs::write(core.join(INDEX_FILE), b"fresh native index").unwrap();

    assert!(matches!(
        stage_vault_import(vault.input()).unwrap(),
        StageOutcome::NativeFirst
    ));
    assert_eq!(
        std::fs::read(core.join(INDEX_FILE)).unwrap(),
        b"native index"
    );
    assert!(!vault.staging().exists());
}

/// A take-back of the staged index out of `core/` that fails part way (its WAL cannot move)
/// leaves `index.db` in `core/` beside the WAL, never a WAL without its database.
#[test]
fn a_partial_take_back_never_leaves_a_wal_without_its_index() {
    let vault = Vault::new();
    let staged = staged(stage_vault_import(vault.input()).unwrap());
    let (core, staging) = (vault.core(), vault.staging());
    crash::hook("install:index-renamed", move || {
        std::fs::write(core.join(DATA_FILE), b"native data").unwrap();
        std::fs::write(core.join(format!("{INDEX_FILE}-wal")), b"native wal").unwrap();
        std::fs::write(staging.join(format!("{INDEX_FILE}-wal")), b"occupied").unwrap();
    });
    assert!(staged.install().is_err());
    assert!(vault.core().join(format!("{INDEX_FILE}-wal")).exists());
    assert!(vault.core().join(INDEX_FILE).exists());
}
