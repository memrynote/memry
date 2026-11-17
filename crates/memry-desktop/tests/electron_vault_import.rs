//! The Electron vault import (Step 36, #3553) over real SQLite files built by
//! `support/electron_db.rs`: refusals before any write, the Electron files left byte for byte,
//! `AlreadyImported` and `NativeFirst`, and a crash at every named point followed by a rerun.
//! Its own binary: the crash points panic through `catch_unwind`, and the feature that arms
//! them (`import-crash-points`) is on for this crate's tests only.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use memry_core::storage::import::{DATA_FILE, INDEX_FILE, read_marker};
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::{
    CORE_DIR, STAGING_DIR, StageOutcome, VaultImportInput, VaultStageReport, crash,
    stage_vault_import,
};
use rusqlite::Connection;
use rusqlite::types::Value;
use sha2::{Digest, Sha256};

#[path = "support/electron_db.rs"]
mod electron_db;

const NOW_MS: i64 = 1_800_000_000_000;

struct Vault {
    _dir: tempfile::TempDir,
    root: PathBuf,
    pair: electron_db::ElectronPair,
}

impl Vault {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let pair = electron_db::create_pair(&root.join(".memry"));
        Self {
            _dir: dir,
            root,
            pair,
        }
    }

    fn input(&self) -> VaultImportInput {
        VaultImportInput {
            vault_dir: self.root.clone(),
            vault_id: "vault-1".into(),
            electron_data_db: self.pair.data.clone(),
            electron_index_db: self.pair.index.clone(),
            docs: Vec::new(),
            extra_owed_docs: Vec::new(),
            vault_key: None,
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
    assert_eq!(report.checks_passed, vec![1, 6]);
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
        |e| matches!(e, ImportError::NotReady(what) if what.contains("data.db/settings")),
    );

    let vault = Vault::new();
    electron_db::seed(
        &vault.data_conn(),
        "sync_state",
        &[("key", Value::Text("lastCursor".into()))],
    );
    assert_refused(
        &vault,
        |e| matches!(e, ImportError::NotReady(what) if what.contains("lastCursor")),
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

    for point in crash::POINTS {
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
