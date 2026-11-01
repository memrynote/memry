//! The once-per-vault import of the pre-sync template files (Step 13l, #3530) on a real vault,
//! over files Electron's pre-sync builds wrote (`tests/fixtures/electron-templates`, from
//! `scripts/electron-fixtures/capture-templates.mjs`), after `vault/templates-migration.ts`.
//!
//! | Test                                                          | Rule                                |
//! | ------------------------------------------------------------- | ----------------------------------- |
//! | Electron's files import as Electron imported them             | `migrateTemplateFilesToDb` rows     |
//! | a file that cannot be read holds the flag, the next open ends | retry, no doubles, files stay       |
//! | a link out of the vault is never read                          | #2936                               |
//! | no folder sets nothing, and a folder that comes later imports  | the late cloud folder               |
//! | beside Electron's database the import waits or defers to it    | Step 36 carries Electron's rows     |
//! | what failed and what never imports reach the activity log      | recovery state reaches the screen   |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::templates::Templates;
use memry_desktop::templates::legacy::{self, LegacyImport, LegacyOutcome};
use memry_desktop::vault::activity::{ActivityKind, ActivitySource};
use rusqlite::Connection;
use serde_json::Value;

const NOW: i64 = 1_760_000_000_000;
const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/electron-templates"
);

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Lib {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    templates: Templates,
}

impl Lib {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("memry-templates-legacy-")
            .tempdir()
            .expect("tmp");
        let vault = dir.path().join("vault");
        let core = vault.join(".memry").join("core");
        std::fs::create_dir_all(&core).expect("vault dirs");
        let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
        ensure_device_identity(store.clone()).expect("device identity");
        let db =
            Vault::open("vault".into(), core.to_string_lossy().into_owned()).expect("open data.db");
        Self {
            templates: Templates::new(vault.clone(), db.templates(store).expect("store")),
            _dir: dir,
            vault,
        }
    }

    fn folder(&self) -> PathBuf {
        self.vault.join(".memry").join("templates")
    }

    fn write(&self, name: &str, text: &str) -> PathBuf {
        std::fs::create_dir_all(self.folder()).expect("templates dir");
        let path = self.folder().join(name);
        std::fs::write(&path, text).expect("write");
        path
    }

    fn import(&self) -> LegacyImport {
        self.templates.import_legacy(NOW).expect("the import")
    }

    /// A second connection to the core database, as another part of the app writes it.
    fn core(&self) -> Connection {
        Connection::open(self.vault.join(".memry/core/data.db")).expect("core data.db")
    }

    /// The stored payload: what the import wrote, before any read rule.
    fn payload(&self, id: &str) -> Option<Value> {
        let raw: Option<String> = self
            .core()
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = 'template' AND item_id = ?1",
                [id],
                |row| row.get(0),
            )
            .ok();
        raw.map(|raw| serde_json::from_str(&raw).expect("JSON"))
    }

    fn customs(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .templates
            .list()
            .expect("list")
            .into_iter()
            .filter(|t| !t.is_built_in)
            .map(|t| t.id)
            .collect();
        ids.sort();
        ids
    }

    /// Electron's `data.db` beside the core one, with its settings table.
    fn electron_db(&self, flag: Option<&str>) {
        let conn = Connection::open(self.vault.join(".memry/data.db")).expect("electron db");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, modified_at TEXT)",
        )
        .expect("settings table");
        if let Some(flag) = flag {
            conn.execute(
                "INSERT INTO settings VALUES ('templates.importedFromFiles', ?1, '')",
                [flag],
            )
            .expect("flag");
        }
    }

    fn core_meta(&self, key: &str, value: &str) {
        self.core()
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [key, value],
            )
            .expect("meta");
    }
}

fn fixture_files() -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = std::fs::read_dir(Path::new(FIXTURE).join("templates"))
        .expect("fixture")
        .map(|entry| {
            let entry = entry.expect("entry");
            let name = entry.file_name().into_string().expect("UTF-8 name");
            (name, std::fs::read(entry.path()).expect("read"))
        })
        .collect();
    files.sort();
    files
}

#[test]
fn electrons_files_import_as_electron_imported_them() {
    let lib = Lib::new();
    std::fs::create_dir_all(lib.folder()).expect("dir");
    for (name, bytes) in fixture_files() {
        std::fs::write(lib.folder().join(name), bytes).expect("copy");
    }
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(FIXTURE).join("expected.json")).expect("expected"),
    )
    .expect("JSON");
    let rows = expected["rows"].as_array().expect("rows");

    let run = lib.import();
    assert_eq!(run.outcome, LegacyOutcome::Done);
    assert!(run.failed.is_empty(), "{:?}", run.failed);
    // Electron's rows, plus the file with an unquoted date, which Electron drops.
    assert_eq!(run.imported, rows.len() + 1);
    assert_eq!(expected["imported"].as_u64(), Some(rows.len() as u64));
    for row in rows {
        let id = row["id"].as_str().expect("id");
        let payload = lib.payload(id).expect("imported");
        for key in [
            "name",
            "description",
            "icon",
            "tags",
            "properties",
            "content",
            "createdAt",
            "modifiedAt",
        ] {
            assert_eq!(payload[key], row[key], "{id}.{key}");
        }
    }
    let dated = lib.payload("dated1").expect("the unquoted date imports");
    assert_eq!(dated["createdAt"], "2024-05-06T07:08:09.000Z");
    assert_eq!(
        run.refused
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        [".memry/templates/broken.md"]
    );
    let mut ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().expect("id").to_owned())
        .chain(["dated1".to_owned()])
        .collect();
    ids.sort();
    assert_eq!(lib.customs(), ids, "no built-in file became a template");

    // The files stay as they were, and the next open adds nothing.
    for (name, bytes) in fixture_files() {
        assert_eq!(
            std::fs::read(lib.folder().join(&name)).expect("kept"),
            bytes,
            "{name}"
        );
    }
    assert_eq!(lib.import(), LegacyImport::default());
}

#[test]
fn a_file_that_cannot_be_read_holds_the_flag_and_the_next_open_ends_it() {
    let lib = Lib::new();
    lib.write("good.md", "---\nid: good\nname: Good\n---\nbody");
    // A second hard link: a name the vault tier never reads.
    let held = lib.write("held.md", "---\nid: held\nname: Held\n---\nbody");
    let other = lib.vault.join("elsewhere.md");
    std::fs::hard_link(&held, &other).expect("hard link");

    let run = lib.import();
    assert_eq!(run.outcome, LegacyOutcome::Retry);
    assert_eq!(run.imported, 1);
    assert_eq!(run.failed.len(), 1);
    assert_eq!(run.failed[0].0, ".memry/templates/held.md");
    let again = lib.import();
    assert_eq!((again.outcome, again.imported), (LegacyOutcome::Retry, 0));

    std::fs::remove_file(&other).expect("unlink");
    let last = lib.import();
    assert_eq!((last.outcome, last.imported), (LegacyOutcome::Done, 1));
    assert_eq!(lib.customs(), ["good", "held"]);
    assert!(held.is_file(), "the file stays");
    assert_eq!(lib.import(), LegacyImport::default());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_vault_is_never_read() {
    let lib = Lib::new();
    let outside = lib.vault.parent().expect("parent").join("private.md");
    std::fs::write(&outside, "---\nid: leak\nname: Leak\n---\nOutside secret").expect("outside");
    std::fs::create_dir_all(lib.folder()).expect("dir");
    std::os::unix::fs::symlink(&outside, lib.folder().join("leak.md")).expect("symlink");
    lib.write("good.md", "---\nid: good\n---\nbody");

    let run = lib.import();
    assert_eq!(run.outcome, LegacyOutcome::Retry);
    assert_eq!(lib.customs(), ["good"]);
    assert_eq!(lib.payload("leak"), None);
}

#[test]
fn no_folder_sets_nothing_and_a_folder_that_comes_later_imports() {
    let lib = Lib::new();
    assert_eq!(lib.import().outcome, LegacyOutcome::NoFolder);
    lib.write("late.md", "---\nid: late\nname: Late Arrival\n---\nbody");
    let run = lib.import();
    assert_eq!((run.outcome, run.imported), (LegacyOutcome::Done, 1));
}

#[test]
fn beside_electrons_database_the_import_waits_or_defers_to_it() {
    // Not imported yet: Electron's ids are its rows', which only the import carries.
    let waiting = Lib::new();
    waiting.electron_db(Some("1"));
    waiting.write("mine.md", "---\nid: mine\n---\nbody");
    assert_eq!(
        waiting.import().outcome,
        LegacyOutcome::WaitsForElectronImport
    );
    assert_eq!(waiting.payload("mine"), None);
    assert_eq!(
        waiting.import().outcome,
        LegacyOutcome::WaitsForElectronImport,
        "nothing was flagged"
    );

    // Imported, and Electron's rows already held the files: a file whose template was
    // deleted in Electron is not brought back.
    let imported = Lib::new();
    imported.electron_db(Some("1"));
    imported.core_meta("electron_import.v1", "{}");
    imported.write("deleted-in-electron.md", "---\nid: gone\n---\nbody");
    assert_eq!(imported.import(), LegacyImport::default());
    assert_eq!(imported.payload("gone"), None);

    // Imported, and Electron never brought its files in: they import now.
    let pending = Lib::new();
    pending.electron_db(None);
    pending.core_meta("electron_import.v1", "{}");
    pending.write("old.md", "---\nid: old\n---\nbody");
    assert_eq!(pending.import().imported, 1);

    // A vault this app made first, which Electron opened later: its files are this vault's.
    let native = Lib::new();
    native.electron_db(Some("1"));
    native.core_meta("vault.origin.v1", "native");
    native.write("new.md", "---\nid: new\n---\nbody");
    assert_eq!(native.import().imported, 1);
}

#[test]
fn what_failed_and_what_never_imports_reach_the_activity_log() {
    let run = LegacyImport {
        imported: 0,
        failed: vec![(".memry/templates/a.md".into(), "busy".into())],
        refused: vec![
            (".memry/templates/b.md".into(), "frontmatter: bad".into()),
            (".memry/templates/c.md".into(), "file-too-large".into()),
        ],
        outcome: LegacyOutcome::Retry,
    };
    let entries = legacy::activity(&run);
    let seen: Vec<_> = entries
        .iter()
        .map(|e| {
            (
                e.kind,
                e.source,
                e.path.as_deref(),
                e.reason.as_deref(),
                e.message.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            (
                ActivityKind::Failed,
                ActivitySource::Import,
                Some(".memry/templates/a.md"),
                Some("read-failed"),
                Some("busy"),
            ),
            (
                ActivityKind::Skipped,
                ActivitySource::Import,
                Some(".memry/templates/b.md"),
                None,
                Some("frontmatter: bad"),
            ),
            (
                ActivityKind::Skipped,
                ActivitySource::Import,
                Some(".memry/templates/c.md"),
                Some("file-too-large"),
                None,
            ),
        ]
    );
    assert!(
        entries.iter().all(|e| e.dedupe.is_some()),
        "once a day per file"
    );
}
