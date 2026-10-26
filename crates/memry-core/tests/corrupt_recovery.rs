//! Recovering a corrupt `data.db` through the real storage adapter.
//!
//! A vault with tasks, a queued outbox row and a device id is damaged the way a
//! bad sector does it: one page of a bulk table is overwritten. Opening reports
//! it, recovery quarantines the file, and the rows that matter come across.
//!
//! | Test                                                | Rule                                 |
//! | --------------------------------------------------- | ------------------------------------ |
//! | open reports corruption instead of a hybrid         | `StorageError::Corrupt`              |
//! | recovery keeps tasks, the outbox and the device id  | every core table is salvaged         |
//! | the damaged file is moved aside, never deleted      | production data, maybe the only copy |
//! | the rebuilt database opens and takes writes         | the vault is usable again            |

mod http_fakes;

use std::path::{Path, PathBuf};

use http_fakes::FakeSecureStore;
use memry_core::api::errors::StorageError;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::recovery::quarantine_and_rebuild;
use memry_core::storage::{Db, OpenOptions, open_data, open_data_with};

/// What desktop opens with: damage is reported, not carried on past.
const VERIFIED: OpenOptions = OpenOptions {
    verify_integrity: true,
};
const TASKS: usize = 25;
const BULK_ROWS: usize = 1_500;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.read_blocking(|conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
        .expect("count")
}

fn device_id(db: &Db) -> String {
    db.read_blocking(|conn| {
        conn.query_row(
            "SELECT value FROM meta WHERE key = 'device.id'",
            [],
            |row| row.get(0),
        )
        .map_err(failed)
    })
    .expect("device id")
}

/// A scratch directory removed when the test is done, pass or fail.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix(&format!("memry-corrupt-{label}-"))
            .tempdir()
            .expect("the scratch directory")
            .keep();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory");
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Damaged {
    _scratch: Scratch,
    dir: PathBuf,
    path: PathBuf,
    /// Queued changes before the damage: the rows that must not be lost.
    outbox_rows: i64,
}

/// A closed vault directory whose `data.db` holds real tasks written through the
/// API, their outbox rows, a device id, and a bulk table to damage.
fn vault_with_a_damaged_page(label: &str) -> Damaged {
    let scratch = Scratch::new(label);
    let dir = scratch.0.clone();
    let path = dir.join("data.db");

    let outbox_rows = {
        let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");
        let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
        let store = FakeSecureStore::new();
        store
            .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
            .expect("plant the signing key");
        let tasks = vault.tasks(store).expect("the task surface");
        let project = tasks
            .create_project(ProjectDraft {
                name: "Work".to_owned(),
                description: None,
                color: None,
                icon: None,
                statuses: None,
            })
            .expect("a project");
        for i in 0..TASKS {
            tasks
                .create(NewTaskInput {
                    title: format!("Task {i}"),
                    project_id: project.clone(),
                    status_id: None,
                    parent_id: None,
                    priority: 0,
                    description: None,
                    due_date: None,
                    due_time: None,
                    start_date: None,
                    repeat: None,
                    repeat_from: None,
                    tags: Vec::new(),
                    linked_note_ids: Vec::new(),
                    linked_canvas_ids: Vec::new(),
                    source_note_id: None,
                    position: None,
                })
                .expect("a task");
        }
        vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('device.id', 'device-recovered')",
                    [],
                )
                .map_err(failed)?;
                let mut put = conn
                    .prepare(
                        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                         VALUES ('note', ?1, ?2, 'full', 1)",
                    )
                    .map_err(failed)?;
                let filler = "x".repeat(300);
                for i in 0..BULK_ROWS {
                    put.execute([format!("bulk-{i}"), filler.clone()]).map_err(failed)?;
                }
                Ok(())
            })
            .expect("seed");
        let outbox_rows = count(&vault.db_handle(), "SELECT COUNT(*) FROM outbox");
        assert!(outbox_rows > TASKS as i64, "every write queued a change");
        outbox_rows
        // The last handle closing checkpoints the WAL into data.db.
    };
    assert!(
        !dir.join("data.db-wal").exists(),
        "the WAL was checkpointed away"
    );
    damage_root_page_of(&path, "sync_items");
    Damaged {
        _scratch: scratch,
        dir,
        path,
        outbox_rows,
    }
}

/// Overwrites the root page of `table` with garbage, leaving every other page
/// readable.
fn damage_root_page_of(path: &Path, table: &str) {
    let conn = rusqlite::Connection::open(path).expect("open to find the page");
    let root: i64 = conn
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .expect("root page");
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("page size");
    drop(conn);

    let mut bytes = std::fs::read(path).expect("read");
    let start = ((root - 1) * page_size) as usize;
    bytes[start..start + page_size as usize].fill(0xFF);
    std::fs::write(path, bytes).expect("write the damage back");
}

#[test]
fn corrupt_recovery_open_reports_the_damage() {
    let damaged = vault_with_a_damaged_page("open");
    let path = damaged.path.clone();

    let refused = open_data_with(&path, VERIFIED);

    assert!(
        matches!(refused, Err(StorageError::Corrupt { .. })),
        "{:?}",
        refused.err()
    );
}

#[test]
fn corrupt_recovery_salvages_tasks_outbox_and_device_id() {
    let damaged = vault_with_a_damaged_page("salvage");
    let (path, outbox_rows) = (damaged.path.clone(), damaged.outbox_rows);
    let report = quarantine_and_rebuild(&path).expect("recovery never fails on damage");

    let db = open_data(&path).expect("the rebuilt database opens");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM tasks"), TASKS as i64);
    assert_eq!(device_id(&db), "device-recovered");
    // Every queued change survived.
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), outbox_rows);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM projects"), 1);

    // The damaged table is reported, with what could be read before the damage.
    let bulk = report
        .tables
        .iter()
        .find(|t| t.table == "sync_items")
        .expect("sync_items was attempted");
    assert!(
        bulk.read_error.is_some(),
        "the unreadable table says so: {bulk:?}"
    );
    let tasks = report
        .tables
        .iter()
        .find(|t| t.table == "tasks")
        .expect("tasks");
    assert_eq!(tasks.copied, TASKS as u64);
    assert!(tasks.read_error.is_none());
}

#[test]
fn corrupt_recovery_moves_the_damaged_file_aside_and_keeps_it() {
    let damaged = vault_with_a_damaged_page("quarantine");
    let dir = damaged.dir.clone();
    let path = damaged.path.clone();

    let damaged = std::fs::read(&path).expect("read the damage");

    let report = quarantine_and_rebuild(&path).expect("recover");

    let name = report
        .quarantined
        .file_name()
        .expect("name")
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("data.db.corrupt-"), "{name}");
    assert_eq!(std::fs::read(&report.quarantined).expect("kept"), damaged);
    assert!(
        dir.join("data.db").exists(),
        "a fresh database stands in its place"
    );
}

#[test]
fn corrupt_recovery_leaves_a_vault_that_takes_writes_and_reopens() {
    let damaged = vault_with_a_damaged_page("usable");
    let path = damaged.path.clone();

    quarantine_and_rebuild(&path).expect("recover");

    let db = open_data(&path).expect("open");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('after', 'recovery')",
            [],
        )
        .map_err(failed)
    })
    .expect("a write");
    drop(db);

    let db = open_data(&path).expect("reopen");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM meta WHERE key = 'after'"),
        1
    );
}

#[test]
fn corrupt_recovery_runtime_read_error_is_recognised_as_corruption() {
    let damaged = vault_with_a_damaged_page("runtime");
    let path = damaged.path.clone();

    // A handle that was opened before the damage surfaced: it opens fine and
    // fails on the first statement that reaches the damaged page.
    let db = Db::open(&path).expect("opening reads only the header");

    let error = db
        .read_blocking(|conn| {
            conn.query_row("SELECT SUM(LENGTH(payload)) FROM sync_items", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(failed)
        })
        .expect_err("the damaged page cannot be read");

    assert!(error.is_corrupt(), "{error:?}");
    assert!(
        !StorageError::Failed {
            what: "disk full".to_owned()
        }
        .is_corrupt()
    );
}

#[test]
fn corrupt_recovery_open_leaves_the_damaged_file_byte_identical() {
    let damaged = vault_with_a_damaged_page("untouched");
    let dir = damaged.dir.clone();
    let path = damaged.path.clone();

    let before = std::fs::read(&path).expect("read");

    let refused = open_data_with(&path, VERIFIED);

    assert!(matches!(refused, Err(StorageError::Corrupt { .. })));
    assert_eq!(
        std::fs::read(&path).expect("read"),
        before,
        "nothing was changed"
    );
    // A read-only look at a WAL database may create empty `-wal` / `-shm`
    // files; it must not leave a log with content in it.
    let wal = std::fs::metadata(dir.join("data.db-wal")).map_or(0, |m| m.len());
    assert_eq!(wal, 0, "nothing was written to the log");
}

#[test]
fn corrupt_recovery_reports_a_salvage_that_could_not_start() {
    // Not a database at all: the header is gone, so no table can be listed.
    let scratch = Scratch::new("total");
    let path = scratch.0.join("data.db");
    std::fs::write(&path, vec![0xAB; 8192]).expect("garbage");

    let report = quarantine_and_rebuild(&path).expect("a fresh database is still built");

    assert!(report.tables.is_empty());
    assert!(
        report.salvage_error.is_some(),
        "an empty report must not look like a clean, empty salvage"
    );
    assert_eq!(
        std::fs::read(&report.quarantined).expect("kept"),
        vec![0xAB; 8192]
    );
    open_data(&path).expect("the fresh database opens");
}

#[test]
fn corrupt_recovery_salvages_a_table_that_only_shares_a_prefix_with_a_virtual_one() {
    let scratch = Scratch::new("prefix");
    let path = scratch.0.join("data.db");
    {
        let db = open_data(&path).expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch(
                "INSERT INTO note_tags (note_id, tag) VALUES ('n1', 'Work');
                 CREATE VIRTUAL TABLE note USING fts5(body);",
            )
            .map_err(failed)
        })
        .expect("a core table next to a virtual table named like its prefix");
    }

    let report = quarantine_and_rebuild(&path).expect("recover");

    let tags = report
        .tables
        .iter()
        .find(|t| t.table == "note_tags")
        .expect("note_tags was copied");
    assert_eq!(tags.copied, 1);
    let db = open_data(&path).expect("open");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM note_tags"), 1);
    assert!(
        report
            .tables
            .iter()
            .all(|t| t.table != "note" && !t.table.starts_with("note_content"))
    );
}

/// The default open is what `Vault::open` (and so iOS) runs. It must not start
/// refusing a vault that opened before: with one damaged page the vault opens,
/// the healthy tables read, and only the damaged one fails.
#[test]
fn corrupt_recovery_default_open_keeps_opening_a_vault_with_one_damaged_page() {
    let damaged = vault_with_a_damaged_page("default");

    let db = open_data(&damaged.path).expect("the default open carries on");

    assert_eq!(count(&db, "SELECT COUNT(*) FROM tasks"), TASKS as i64);
    let reading = db.read_blocking(|conn| {
        conn.query_row("SELECT SUM(LENGTH(payload)) FROM sync_items", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(failed)
    });
    assert!(reading.expect_err("the damaged table fails").is_corrupt());
}

#[test]
fn corrupt_recovery_default_open_of_a_non_database_is_the_error_it_always_was() {
    let scratch = Scratch::new("garbage");
    let path = scratch.0.join("data.db");
    std::fs::write(&path, vec![0xAB; 8192]).expect("garbage");

    let default = open_data(&path).err().expect("not a database");
    let verified = open_data_with(&path, VERIFIED)
        .err()
        .expect("not a database");

    assert!(
        matches!(default, StorageError::Failed { .. }),
        "{default:?}"
    );
    assert!(
        matches!(verified, StorageError::Corrupt { .. }),
        "{verified:?}"
    );
}

fn set_meta(db: &Db, key: &'static str, value: &'static str) {
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map(drop)
        .map_err(failed)
    })
    .expect("write meta");
}

fn meta(db: &Db, key: &'static str) -> String {
    db.read_blocking(move |conn| {
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .map_err(failed)
    })
    .expect("meta row")
}

/// The app dies after the file moved aside and before the fresh database exists.
fn crash_after_quarantine(scratch: &Scratch) -> (PathBuf, PathBuf) {
    let path = scratch.0.join("data.db");
    let db = open_data(&path).expect("open");
    set_meta(&db, "note.k", "old");
    drop(db);
    let parked = scratch.0.join("data.db.corrupt-1");
    std::fs::rename(&path, &parked).expect("quarantine");
    let marker = scratch.0.join("data.db.recovering");
    std::fs::write(&marker, parked.display().to_string()).expect("marker");
    (path, marker)
}

fn marker_file(scratch: &Scratch) -> PathBuf {
    scratch.0.join("data.db.recovering")
}

fn meta_exists(db: &Db, key: &'static str) -> bool {
    count(
        db,
        match key {
            "note.k" => "SELECT COUNT(*) FROM meta WHERE key = 'note.k'",
            _ => "SELECT COUNT(*) FROM meta WHERE key = 'other'",
        },
    ) > 0
}

fn log_detail(db: &Db) -> (i64, String) {
    db.read_blocking(|conn| {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(MAX(detail), '') FROM recovery_log",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(failed)
    })
    .expect("recovery_log")
}

#[test]
fn corrupt_recovery_default_open_finishes_a_pending_salvage_before_it_hands_out_a_database() {
    let scratch = Scratch::new("marker-race");
    let (path, marker) = crash_after_quarantine(&scratch);

    let db = open_data(&path).expect("the default open still opens");

    assert_eq!(meta(&db, "note.k"), "old", "the parked rows came back");
    assert!(!marker.exists());
    assert_eq!(log_detail(&db).0, 1, "the recovery is recorded in the data");
}

/// The marker that survives a finished recovery (it could not be removed) must
/// not bring a row back that the user deleted since.
#[test]
fn corrupt_recovery_a_leftover_marker_never_salvages_twice() {
    let scratch = Scratch::new("marker-leftover");
    let (path, marker) = crash_after_quarantine(&scratch);
    let db = open_data(&path).expect("salvage");
    db.call_blocking(|conn| {
        conn.execute("DELETE FROM meta WHERE key = 'note.k'", [])
            .map(drop)
            .map_err(failed)
    })
    .expect("the user deletes the row");
    drop(db);

    let parked = scratch.0.join("data.db.corrupt-1");
    std::fs::write(&marker, parked.display().to_string()).expect("marker is back");
    let db = open_data(&path).expect("reopen");
    assert!(
        !meta_exists(&db, "note.k"),
        "the deleted row stayed deleted"
    );
    assert!(!marker.exists(), "and the stale marker was cleared");
    drop(db);

    std::fs::write(&marker, parked.display().to_string()).expect("marker is back");
    let db = open_data_with(&path, VERIFIED).expect("the verified open agrees");
    assert!(!meta_exists(&db, "note.k"));
}

/// A shell pruned the quarantine (08c prunes `data.db.corrupt-*`) while a marker
/// was left: the healthy database must open as it is.
#[test]
fn corrupt_recovery_a_marker_without_its_quarantine_never_moves_a_live_database() {
    let scratch = Scratch::new("marker-pruned");
    let path = scratch.0.join("data.db");
    let db = open_data(&path).expect("open");
    set_meta(&db, "note.k", "live");
    drop(db);
    std::fs::write(
        marker_file(&scratch),
        scratch.0.join("data.db.corrupt-gone").display().to_string(),
    )
    .expect("marker");

    for options in [OpenOptions::default(), VERIFIED] {
        let db = open_data_with(&path, options).expect("opens");
        assert_eq!(meta(&db, "note.k"), "live");
        drop(db);
        std::fs::write(
            marker_file(&scratch),
            scratch.0.join("data.db.corrupt-gone").display().to_string(),
        )
        .expect("marker");
    }
    let moved = std::fs::read_dir(&scratch.0)
        .expect("dir")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-"));
    assert!(!moved, "nothing was moved aside");
}

#[test]
fn corrupt_recovery_verified_open_refuses_while_a_salvage_is_pending() {
    let scratch = Scratch::new("marker-verified");
    let (path, _) = crash_after_quarantine(&scratch);

    let refused = open_data_with(&path, VERIFIED);

    assert!(matches!(refused, Err(StorageError::Corrupt { .. })));
    assert!(!path.exists(), "and it created nothing");
}

/// A quarantine that cannot be read right now (permissions here; a lock or an I/O
/// error in the field) is not damage: the open fails, the marker stays, and no
/// empty vault is handed out. Once it can be read the salvage completes.
#[cfg(unix)]
#[test]
fn corrupt_recovery_a_transient_salvage_failure_fails_closed_and_retries() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("marker-transient");
    let (path, marker) = crash_after_quarantine(&scratch);
    let parked = scratch.0.join("data.db.corrupt-1");
    std::fs::set_permissions(&parked, std::fs::Permissions::from_mode(0o000)).expect("chmod");
    if std::fs::File::open(&parked).is_ok() {
        return; // root ignores permissions; nothing to prove here
    }

    let refused = open_data(&path);
    assert!(
        matches!(refused, Err(StorageError::Failed { .. })),
        "{:?}",
        refused.err()
    );
    assert!(marker.exists(), "the marker stays");
    assert!(
        matches!(
            open_data_with(&path, VERIFIED),
            Err(StorageError::Corrupt { .. })
        ),
        "an empty database is not handed out"
    );

    std::fs::set_permissions(&parked, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    let db = open_data(&path).expect("the retry finishes");
    assert_eq!(meta(&db, "note.k"), "old");
    assert!(!marker.exists());
}

/// Damage in the quarantine is permanent: retrying cannot help, so the recovery
/// is recorded with what was lost, the marker goes, and the vault opens.
#[test]
fn corrupt_recovery_a_quarantine_that_is_not_a_database_is_recorded_and_settled() {
    let scratch = Scratch::new("marker-notadb");
    let (path, marker) = crash_after_quarantine(&scratch);
    std::fs::write(scratch.0.join("data.db.corrupt-1"), vec![0xAB; 8192]).expect("garbage");

    let db = open_data(&path).expect("opens, empty");

    let (rows, detail) = log_detail(&db);
    assert_eq!(rows, 1);
    assert!(detail.contains("damaged file"), "{detail}");
    assert!(!marker.exists());
    assert!(scratch.0.join("data.db.corrupt-1").exists(), "kept");
    drop(db);
    open_data(&path).expect("and it opens again, without a second attempt");
}

#[test]
fn corrupt_recovery_copied_counts_inserted_rows_not_ignored_ones() {
    let scratch = Scratch::new("copied");
    let path = scratch.0.join("data.db");
    let db = open_data(&path).expect("open");
    set_meta(&db, "note.k", "old");
    let before = count(&db, "SELECT COUNT(*) FROM meta");
    drop(db);

    let report = quarantine_and_rebuild(&path).expect("recover");

    let table = report
        .tables
        .iter()
        .find(|t| t.table == "meta")
        .expect("meta salvaged");
    let db = open_data(&path).expect("open");
    let after = count(&db, "SELECT COUNT(*) FROM meta");
    assert_eq!(after, before, "nothing lost, nothing doubled");
    assert_eq!(
        (table.copied + table.already_present) as i64,
        before,
        "{table:?}"
    );
    assert_eq!(
        table.copied as i64,
        before - table.already_present as i64,
        "copied counts only inserted rows: {table:?}"
    );
}
