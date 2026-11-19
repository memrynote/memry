//! The sandbox replay (`memry_desktop::sandbox::replay`) through its real seams: the committed
//! template replayed into a folder, then opened by a real session, vault tier and note identity,
//! as the app opens the Sandbox. Every note the replay created in the core keeps its id once the
//! open walk finds its file, so the ids in other notes' links hold; a crash and a rerun converge
//! on one vault; a folder with someone's files is never replaced unasked; and hostile templates
//! are refused before anything is written.
//!
//! ```text
//! cargo test -p memry-desktop --test sandbox_replay
//! ```

mod device_key;
mod vault_env;

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::registry::vault_icon;
use memry_desktop::sandbox::replay::{MAX_DEPTH, SANDBOX_VAULT_ICON};
use memry_desktop::sandbox::{
    ReplayOptions, SandboxError, SeedCounts, Template, TemplateInfo, replay,
};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vault_env::{env_named, indexed};

const TEMPLATE_NOW: &str = "2026-01-14T12:00:00.000Z";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn template() -> Template {
    let assets = crate_dir().join("../../apps/cli/src/sandbox/assets");
    Template::load(&crate_dir().join("resources/sandbox"), &assets).unwrap()
}

fn at(iso: &str) -> DateTime<Utc> {
    iso.parse().unwrap()
}

fn options(replace: bool) -> ReplayOptions {
    ReplayOptions {
        rebase_dates: false,
        now: at(TEMPLATE_NOW),
        replace,
    }
}

fn data_db(vault: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(vault.join(".memry/core/data.db")).unwrap()
}

/// The live markdown notes in the vault's core: id, folder and title.
fn core_notes(vault: &Path) -> BTreeSet<(String, Option<String>, String)> {
    let db = data_db(vault);
    let mut statement = db
        .prepare(
            "SELECT id, folder_path, title FROM notes \
             WHERE deleted_at IS NULL AND file_type = 'markdown'",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Vault-relative paths of every file under `root`, the core's databases left out.
fn files(root: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel.starts_with(".memry/core") {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else {
                out.insert(rel);
            }
        }
    }
    out
}

fn siblings(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn replayed_notes_keep_their_core_ids_through_the_first_open() {
    let template = template();
    let info = TemplateInfo::parse(
        &fs::read(crate_dir().join("resources/sandbox/manifest.json")).unwrap(),
    )
    .unwrap();
    let mut e = env_named("Sandbox", |store| Some(NotesIdentity::new(store)));
    let counts = replay(
        &template,
        &e.vault,
        &options(false),
        device_key::with_device_key(),
    )
    .unwrap();
    let count = |name: &str| usize::try_from(info.count(name).unwrap()).unwrap();
    assert_eq!(
        counts,
        SeedCounts {
            notes: count("notes"),
            journal_entries: count("journal entries"),
            files: count("files"),
            canvases: count("canvases"),
        }
    );
    let created = core_notes(&e.vault);
    assert_eq!(created.len(), counts.notes);

    e.drain();
    e.open();
    e.facts_until(indexed);
    let rows: BTreeSet<(String, String)> = e.rows().into_iter().collect();
    for (id, folder, title) in &created {
        let path = match folder {
            Some(folder) => format!("{folder}/{title}.md"),
            None => format!("{title}.md"),
        };
        assert!(
            rows.contains(&(id.clone(), path.clone())),
            "{path} is not the note {id} the replay created"
        );
    }
    let orphans: i64 = data_db(&e.vault)
        .query_row(
            "SELECT count(*) FROM notes n WHERE n.deleted_at IS NULL \
             AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        orphans, 0,
        "a replayed note has no file: the open made a second one"
    );

    // Every note link in the vault names a note the open kept; no template note id is left.
    let row_ids: BTreeSet<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    let link = Regex::new(r"memry://note/([A-Za-z0-9_-]+)").unwrap();
    let template_ids: BTreeSet<&str> = template.manifest.data["note_metadata"]
        .iter()
        .filter(|row| row["file_type"] == "markdown" && row["journal_date"].is_null())
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    let mut links = 0;
    for rel in files(&e.vault).iter().filter(|rel| rel.ends_with(".md")) {
        let text = fs::read_to_string(e.vault.join(rel)).unwrap();
        for found in link.captures_iter(&text) {
            links += 1;
            assert!(row_ids.contains(&found[1]), "{rel} links {}", &found[1]);
        }
        assert!(
            !template_ids.iter().any(|old| text.contains(old)),
            "{rel} keeps a template note id"
        );
    }
    assert!(links > 0);
    assert_eq!(
        vault_icon::read(&e.vault).and_then(|icon| icon.value),
        Some(SANDBOX_VAULT_ICON.to_owned())
    );
    e.close();
}

/// Replayed on 2028-03-01, the vault has the paths Electron's generator wrote that day
/// (`tests/fixtures/sandbox/rebase-2028-03-01.json`): journal days moved, two past-year days
/// on 2027-02-28 kept once.
#[test]
fn a_rebased_replay_writes_the_generators_paths_for_that_day() {
    let vector: Value = serde_json::from_slice(
        &fs::read(crate_dir().join("tests/fixtures/sandbox/rebase-2028-03-01.json")).unwrap(),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Sandbox");
    let options = ReplayOptions {
        rebase_dates: true,
        now: at(vector["now"].as_str().unwrap()),
        replace: false,
    };
    replay(
        &template(),
        &target,
        &options,
        device_key::with_device_key(),
    )
    .unwrap();
    // The vector leaves out `attachments/`, whose folders and file names carry per-run ids.
    let expected: BTreeSet<String> = vector["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_owned())
        .collect();
    let written: BTreeSet<String> = files(&target)
        .into_iter()
        .filter(|path| !path.starts_with("attachments/"))
        .collect();
    assert_eq!(written, expected);
}

#[test]
fn a_rerun_after_a_crash_converges_on_one_vault() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Sandbox");
    // What a replay killed mid-build, and one killed after its two renames, leave behind.
    let leave = |left: &str| {
        fs::create_dir_all(dir.path().join(left).join(".memry")).unwrap();
        fs::write(dir.path().join(left).join("half.md"), "half\n").unwrap();
    };
    leave(".Sandbox.sandbox-dead");
    let store = device_key::with_device_key();
    let first = replay(&template(), &target, &options(false), store.clone()).unwrap();
    assert_eq!(siblings(dir.path()), ["Sandbox"]);
    assert_eq!(core_notes(&target).len(), first.notes);

    leave(".Sandbox.replaced-dead");
    let again = replay(&template(), &target, &options(true), store.clone()).unwrap();
    assert_eq!(again, first);
    assert_eq!(siblings(dir.path()), ["Sandbox"]);
    assert_eq!(core_notes(&target).len(), first.notes);

    // A replay that fails mid-build leaves the previous vault as it was and nothing beside it.
    let before = core_notes(&target);
    let mut broken = template();
    broken.assets = dir.path().join("no-assets");
    let failed = replay(&broken, &target, &options(true), store);
    assert!(matches!(failed, Err(SandboxError::Io { .. })), "{failed:?}");
    assert_eq!(siblings(dir.path()), ["Sandbox"]);
    assert_eq!(core_notes(&target), before);
}

/// A replay killed between its two renames left the previous sandbox aside and no target; a
/// rerun that then fails to build still leaves that sandbox in place.
#[test]
fn a_sandbox_left_aside_by_a_crash_is_put_back_before_the_sweep() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Sandbox");
    let store = device_key::with_device_key();
    replay(&template(), &target, &options(false), store.clone()).unwrap();
    let before = core_notes(&target);
    fs::rename(&target, dir.path().join(".Sandbox.replaced-dead")).unwrap();

    let mut broken = template();
    broken.assets = dir.path().join("no-assets");
    let failed = replay(&broken, &target, &options(true), store);
    assert!(matches!(failed, Err(SandboxError::Io { .. })), "{failed:?}");
    assert_eq!(siblings(dir.path()), ["Sandbox"]);
    assert_eq!(core_notes(&target), before);
}

/// `replace` replaces only an earlier sandbox: a vault, or a folder holding vaults, is refused
/// and keeps every file.
#[test]
fn replace_never_replaces_a_folder_that_is_not_a_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("MyVault");
    let mine = [".memry/config.json", "Mine.md", "Child/.memry/config.json"];
    for rel in mine {
        fs::create_dir_all(target.join(rel).parent().unwrap()).unwrap();
        fs::write(target.join(rel), "{}\n").unwrap();
    }
    let refused = replay(
        &template(),
        &target,
        &options(true),
        device_key::with_device_key(),
    );
    assert!(
        matches!(refused, Err(SandboxError::TargetNotEmpty(_))),
        "{refused:?}"
    );
    assert_eq!(files(&target), mine.map(str::to_owned).into());
    assert_eq!(siblings(dir.path()), ["MyVault"]);
}

/// A store that writes a file into the target the first time the build reads it, as a user
/// saving into the folder while the replay runs.
struct LateWrite {
    store: Arc<dyn SecureStore>,
    file: PathBuf,
    written: AtomicBool,
}

impl SecureStore for LateWrite {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if !self.written.swap(true, Ordering::SeqCst) {
            fs::write(&self.file, "written during the build\n").unwrap();
        }
        self.store.get(key)
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.store.set(key, value)
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.store.delete(key)
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.store.clear()
    }
}

#[test]
fn a_file_added_to_an_empty_target_during_the_build_stops_the_replay() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Notes");
    fs::create_dir(&target).unwrap();
    let late = target.join("Late.md");
    let store = Arc::new(LateWrite {
        store: device_key::with_device_key(),
        file: late.clone(),
        written: AtomicBool::new(false),
    });
    let refused = replay(&template(), &target, &options(false), store.clone());
    assert!(store.written.load(Ordering::SeqCst));
    assert!(
        matches!(refused, Err(SandboxError::TargetNotEmpty(_))),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(&late).unwrap(),
        "written during the build\n"
    );
    assert_eq!(files(&target), BTreeSet::from(["Late.md".to_owned()]));
    assert_eq!(siblings(dir.path()), ["Notes"]);
}

/// No template file or asset copy lands in the core's folder, in any case.
#[test]
fn nothing_is_written_into_the_core_folder_in_any_case() {
    let mini = Mini::new("A.md", "a\n");
    mini.file(".MEMRY/core/data.db", b"not a database");
    let refused = mini.replay();
    assert!(
        matches!(refused, Err(SandboxError::UnsafePath(_))),
        "{refused:?}"
    );
    mini.assert_untouched();

    for path in [".memry/core/data.db", ".Memry/Core/data.db"] {
        let mini = Mini::new("A.md", "a\n");
        let bytes = b"not a database";
        fs::write(mini.dir.path().join("assets/db.bin"), bytes).unwrap();
        let sha256 = hex::encode(Sha256::digest(bytes));
        let copy = json!({ "path": path, "asset": "db.bin", "sha256": sha256 });
        let row = json!({
            "id": "note_AAAAAAAAAAAA", "path": "A.md", "file_type": "markdown",
            "journal_date": null, "created_at": TEMPLATE_NOW, "modified_at": TEMPLATE_NOW,
        });
        mini.seed(json!([copy]), json!([row]));
        let refused = mini.replay();
        assert!(
            matches!(refused, Err(SandboxError::UnsafePath(_))),
            "{path}: {refused:?}"
        );
        mini.assert_untouched();
    }
}

#[test]
fn a_folder_with_files_is_never_replaced_unasked() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("Notes");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("Mine.md"), "my note\n").unwrap();
    let store = device_key::with_device_key();
    let refused = replay(&template(), &target, &options(false), store.clone());
    assert!(
        matches!(refused, Err(SandboxError::TargetNotEmpty(_))),
        "{refused:?}"
    );
    assert_eq!(
        fs::read_to_string(target.join("Mine.md")).unwrap(),
        "my note\n"
    );
    assert_eq!(siblings(dir.path()), ["Notes"]);

    let file = dir.path().join("file");
    fs::write(&file, "x").unwrap();
    let refused = replay(&template(), &file, &options(true), store.clone());
    assert!(
        matches!(refused, Err(SandboxError::UnsafeTarget(_))),
        "{refused:?}"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "x");

    #[cfg(unix)]
    {
        let link = dir.path().join("Link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let refused = replay(&template(), &link, &options(true), store);
        assert!(
            matches!(refused, Err(SandboxError::UnsafeTarget(_))),
            "{refused:?}"
        );
        assert_eq!(
            fs::read_to_string(target.join("Mine.md")).unwrap(),
            "my note\n"
        );
    }
}

/// A one-note template in `dir/tpl`, with its assets in `dir/assets`.
struct Mini {
    dir: tempfile::TempDir,
}

impl Mini {
    fn new(note_path: &str, text: &str) -> Self {
        let mini = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        let row = json!({
            "id": "note_AAAAAAAAAAAA", "path": note_path, "file_type": "markdown",
            "journal_date": null, "created_at": TEMPLATE_NOW, "modified_at": TEMPLATE_NOW,
        });
        mini.seed(json!([]), json!([row]));
        mini.file(note_path, text.as_bytes());
        fs::create_dir_all(mini.dir.path().join("assets")).unwrap();
        mini
    }

    fn seed(&self, assets: Value, notes: Value) {
        let seed = json!({
            "version": 1, "generatedAt": TEMPLATE_NOW, "timezone": "UTC",
            "assets": assets, "data": { "note_metadata": notes }, "index": {},
        });
        fs::create_dir_all(self.dir.path().join("tpl/vault")).unwrap();
        fs::write(self.dir.path().join("tpl/seed.json"), seed.to_string()).unwrap();
    }

    fn file(&self, rel: &str, bytes: &[u8]) {
        let path = self.dir.path().join("tpl/vault").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn replay(&self) -> Result<SeedCounts, SandboxError> {
        let template = Template::load(
            &self.dir.path().join("tpl"),
            &self.dir.path().join("assets"),
        )?;
        let target = self.target();
        replay(
            &template,
            &target,
            &options(false),
            device_key::with_device_key(),
        )
    }

    fn target(&self) -> PathBuf {
        self.dir.path().join("out/Sandbox")
    }

    /// Nothing was written beside the target, nor the target itself.
    fn assert_untouched(&self) {
        let out = self.dir.path().join("out");
        assert!(
            !out.exists() || siblings(&out).is_empty(),
            "{:?}",
            siblings(&out)
        );
    }
}

fn on_small_stack<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(work)
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn folders_deeper_than_the_limit_are_refused_on_a_small_stack() {
    let nested = |levels: usize| vec!["d"; levels].join("/");
    let deepest = format!("{}/Deep.md", nested(MAX_DEPTH));
    let ok = on_small_stack(move || Mini::new(&deepest, "deep\n").replay());
    assert_eq!(ok.unwrap().notes, 1);

    let too_deep = format!("{}/Deep.md", nested(MAX_DEPTH + 1));
    let (refused, mini) = on_small_stack(move || {
        let mini = Mini::new(&too_deep, "deep\n");
        (mini.replay(), mini)
    });
    assert!(
        matches!(refused, Err(SandboxError::TooLarge(_))),
        "{refused:?}"
    );
    mini.assert_untouched();
}

#[test]
fn hostile_templates_are_refused_before_anything_is_written() {
    let mini = Mini::new("A.md", "a\n");
    mini.file(".memry/core/data.db", b"not a database");
    let refused = mini.replay();
    assert!(
        matches!(refused, Err(SandboxError::UnsafePath(_))),
        "{refused:?}"
    );
    mini.assert_untouched();

    let mini = Mini::new("A.md", "a\n");
    fs::remove_file(mini.dir.path().join("tpl/vault/A.md")).unwrap();
    let refused = mini.replay();
    assert!(
        matches!(refused, Err(SandboxError::MissingFile(_))),
        "{refused:?}"
    );
    mini.assert_untouched();

    let mini = Mini::new("A.md", "a\n");
    fs::write(mini.dir.path().join("assets/photo.jpg"), b"other bytes").unwrap();
    let copy = json!({ "path": "photo.jpg", "asset": "photo.jpg", "sha256": "0".repeat(64) });
    let row = json!({
        "id": "note_AAAAAAAAAAAA", "path": "A.md", "file_type": "markdown",
        "journal_date": null, "created_at": TEMPLATE_NOW, "modified_at": TEMPLATE_NOW,
    });
    mini.seed(json!([copy]), json!([row]));
    let refused = mini.replay();
    assert!(
        matches!(refused, Err(SandboxError::BadAsset(_))),
        "{refused:?}"
    );
    mini.assert_untouched();

    #[cfg(unix)]
    {
        let mini = Mini::new("A.md", "a\n");
        std::os::unix::fs::symlink("/etc", mini.dir.path().join("tpl/vault/etc")).unwrap();
        let refused = mini.replay();
        assert!(
            matches!(refused, Err(SandboxError::UnsafePath(_))),
            "{refused:?}"
        );
        mini.assert_untouched();
    }
}

/// A fence other than YAML's is the body's text, as the open walk reads it: the note is
/// created with the file as written, and nothing in the fence runs.
#[test]
fn a_non_yaml_fence_is_kept_as_body_text() {
    for text in [
        "---js\nmodule.exports = { title: process.exit(1) }\n---\nbody\n",
        "---json\n{\"title\": \"x\"}\n---\nbody\n",
    ] {
        let mini = Mini::new("Fenced.md", text);
        assert_eq!(mini.replay().unwrap().notes, 1);
        assert_eq!(
            fs::read_to_string(mini.target().join("Fenced.md")).unwrap(),
            text
        );
        assert_eq!(core_notes(&mini.target()).len(), 1);
    }
}
