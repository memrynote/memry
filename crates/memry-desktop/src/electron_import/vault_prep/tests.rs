use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::electron_import::HostOs;
use crate::electron_import::journal_replay::BulkApplyJournal;
use crate::electron_import::profile::AppNameCandidates;

struct Setup {
    root: TempDir,
    profile: ElectronProfile,
    scratch: Scratch,
}

impl Setup {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("memrynote");
        fs::create_dir_all(&dir).unwrap();
        let profile = ElectronProfile {
            dir,
            host: HostOs::current(),
            pin: None,
            app_names: AppNameCandidates(vec!["memrynote"]),
            has_config: true,
            has_secure_store: false,
            has_local_state: false,
            has_local_storage: false,
            has_legacy_crdt_store: false,
            has_custom_dictionary: false,
            crdt_store_dirs: Vec::new(),
            other_candidates: Vec::new(),
        };
        let scratch = Scratch::new(root.path().join("scratch")).unwrap();
        Self {
            root,
            profile,
            scratch,
        }
    }

    /// A vault folder; with `Some(rows)` a `.memry/data.db` holding `vault_metadata` and them.
    fn vault(&self, name: &str, rows: Option<&str>) -> String {
        let dir = self.root.path().join("vaults").join(name);
        fs::create_dir_all(&dir).unwrap();
        if let Some(rows) = rows {
            fs::create_dir_all(dir.join(".memry")).unwrap();
            let db = Connection::open(dir.join(".memry/data.db")).unwrap();
            db.execute_batch(
                "CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid,
                    created_at INTEGER, updated_at INTEGER);",
            )
            .unwrap();
            db.execute_batch(rows).unwrap();
        }
        dir.to_string_lossy().into_owned()
    }

    fn plan(&self, config: serde_json::Value) -> VaultPlan {
        let config = ElectronConfig::parse(config.to_string().as_bytes()).unwrap();
        plan_vaults(&self.profile, Some(&config), &self.scratch)
    }
}

fn singleton(uuid: &str) -> String {
    format!("INSERT INTO vault_metadata VALUES ('singleton', '{uuid}', 1, 1);")
}

fn ids(plan: &VaultPlan, path: &str) -> VaultId {
    match &plan
        .vaults
        .iter()
        .find(|v| v.path == path)
        .unwrap()
        .disposition
    {
        Disposition::Import(ids) => ids.clone(),
        other => panic!("{path}: {other:?}"),
    }
}

#[test]
fn the_current_vault_comes_first_and_each_exact_path_once() {
    let s = Setup::new();
    let a = s.vault("A", Some(&singleton("uuid-a")));
    let b = s.vault("B", Some(&singleton("uuid-b")));
    let b_slash = format!("{b}/");
    let plan = s.plan(json!({
        "currentVault": b,
        "vaults": [{"path": a}, {"path": b}, {"path": a}, {"path": b_slash}, {"name": "no path"}],
    }));
    let order: Vec<(&str, bool)> = plan
        .vaults
        .iter()
        .map(|v| (v.path.as_str(), v.current))
        .collect();
    // A trailing slash is another string, so another vault to Electron (`store.ts:422`).
    assert_eq!(
        order,
        [
            (b.as_str(), true),
            (a.as_str(), false),
            (b_slash.as_str(), false)
        ]
    );
    assert_eq!(plan.duplicate_entries, 1);
    assert_eq!(plan.unreadable_entries, 1);
}

#[test]
fn the_sandbox_and_missing_folders_or_databases_are_not_imported() {
    let s = Setup::new();
    let sandbox = s.profile.dir.join("Sandbox");
    fs::create_dir_all(sandbox.join(".memry")).unwrap();
    let sandbox = sandbox.to_string_lossy().into_owned();
    // Another folder in the profile directory is the user's vault, as Electron keeps it.
    let in_profile = s.profile.dir.join("Notes");
    fs::create_dir_all(&in_profile).unwrap();
    let in_profile = in_profile.to_string_lossy().into_owned();
    let gone = s.root.path().join("gone").to_string_lossy().into_owned();
    let no_db = s.vault("NoDb", None);
    let plan = s.plan(json!({
        "currentVault": sandbox,
        "vaults": [{"path": in_profile}, {"path": gone}, {"path": no_db}],
    }));
    let kinds: Vec<String> = plan
        .vaults
        .iter()
        .map(|v| format!("{:?}", v.disposition))
        .collect();
    assert_eq!(
        kinds,
        [
            "Sandbox",
            "Deferred(DataDbMissing)",
            "Deferred(FolderMissing)",
            "Deferred(DataDbMissing)"
        ]
    );
}

#[test]
fn an_unreadable_vault_id_names_the_row_and_leaves_the_others_planned() {
    let s = Setup::new();
    let bad = s.vault(
        "Bad",
        Some("INSERT INTO vault_metadata VALUES ('singleton', CAST(X'FF' AS TEXT), 1, 1);"),
    );
    let good = s.vault("Good", Some(&singleton("uuid-good")));
    let plan = s.plan(json!({"vaults": [{"path": bad}, {"path": good}]}));
    match &plan.vaults[0].disposition {
        Disposition::Unreadable(error) => {
            assert!(
                error.to_string().contains("vault_metadata row 'singleton'"),
                "{error}"
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(ids(&plan, &good).vault_id, "uuid-good");
}

/// One id per vault, for its core id and its store alike: the singleton's
/// (`crdt-store-path.ts:51-57`), else the config `vaultUuid`, else minted.
#[test]
fn each_vault_resolves_one_id_singleton_first() {
    let s = Setup::new();
    let both = s.vault("Both", Some(&singleton("from-db")));
    let config_only = s.vault("ConfigOnly", Some(""));
    let db_only = s.vault("DbOnly", Some(&singleton("db-only")));
    let neither = s.vault("Neither", Some(""));
    let plan = s.plan(json!({"vaults": [
        {"path": both, "vaultUuid": "from-config"},
        {"path": config_only, "vaultUuid": "config-only"},
        {"path": db_only},
        {"path": neither},
    ]}));
    let pair = |path: &str| {
        let id = ids(&plan, path);
        (id.vault_id, id.minted)
    };
    assert_eq!(pair(&both), ("from-db".into(), false));
    assert_eq!(pair(&config_only), ("config-only".into(), false));
    assert_eq!(pair(&db_only), ("db-only".into(), false));
    let (vault_id, minted) = pair(&neither);
    assert!(minted);
    let parsed = uuid::Uuid::parse_str(&vault_id).unwrap();
    assert_eq!(parsed.get_version_num(), 4);
    assert_eq!(vault_id, parsed.to_string(), "lowercase, as randomUUID");
    assert!(plan.repeated_ids.is_empty());
}

/// A copied vault folder carries its singleton: both copies resolve to one id, which the plan
/// flags so the caller imports neither under it.
#[test]
fn vaults_that_resolve_to_one_id_are_flagged() {
    let s = Setup::new();
    let original = s.vault("Original", Some(&singleton("shared")));
    let copy = s.vault("Copy", Some(&singleton("shared")));
    let by_config = s.vault("ByConfig", Some(""));
    let own = s.vault("Own", Some(&singleton("own")));
    let plan = s.plan(json!({"vaults": [
        {"path": original}, {"path": own}, {"path": copy},
        {"path": by_config, "vaultUuid": "shared"},
    ]}));
    assert_eq!(
        plan.repeated_ids,
        [RepeatedId {
            vault_id: "shared".into(),
            paths: vec![original, copy, by_config],
        }]
    );
}

#[test]
fn no_config_plans_no_vault() {
    let s = Setup::new();
    let plan = plan_vaults(&s.profile, None, &s.scratch);
    assert!(plan.vaults.is_empty());
}

fn write(dir: &Path, rel: &str, bytes: &[u8]) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn the_tree_sees_every_change_outside_memry_and_the_expected_paths() {
    let dir = tempfile::tempdir().unwrap();
    let v = dir.path();
    write(v, "notes/a.md", b"a");
    write(v, "notes/b.md", b"b");
    write(v, "c.md", b"c");
    write(v, ".memry/data.db", b"db");
    let before = VaultTree::read(v).unwrap();
    assert_eq!(before.len(), 4, "{before:?}");

    write(v, "notes/a.md", b"A");
    fs::remove_file(v.join("notes/b.md")).unwrap();
    write(v, "new/d.md", b"d");
    write(v, ".memry/core/data.db", b"core");
    write(v, "c.md", b"c");
    write(v, "replayed/e.md", b"e");
    let after = VaultTree::read(v).unwrap();
    let expected = ExpectedChanges {
        files: ["replayed/e.md".to_owned()].into(),
        folders: ["replayed".to_owned()].into(),
    };
    assert_eq!(
        after.changed_since(&before, &expected),
        ["new", "new/d.md", "notes/a.md", "notes/b.md"]
    );
}

#[cfg(unix)]
#[test]
fn the_tree_records_a_link_and_never_follows_it() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let v = dir.path();
    write(outside.path(), "big.bin", b"outside");
    std::os::unix::fs::symlink(outside.path(), v.join("out")).unwrap();
    std::os::unix::fs::symlink(v, v.join("loop")).unwrap();
    let before = VaultTree::read(v).unwrap();
    assert_eq!(before.len(), 2);
    write(outside.path(), "big.bin", b"changed");
    let after = VaultTree::read(v).unwrap();
    assert!(
        after
            .changed_since(&before, &ExpectedChanges::default())
            .is_empty()
    );
    fs::remove_file(v.join("out")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("elsewhere"), v.join("out")).unwrap();
    let moved = VaultTree::read(v).unwrap();
    assert_eq!(
        moved.changed_since(&before, &ExpectedChanges::default()),
        ["out"]
    );
}

fn journal(entries: serde_json::Value) -> BulkApplyJournal {
    BulkApplyJournal::parse(
        json!({"writtenAt": 0, "entries": entries})
            .to_string()
            .as_bytes(),
    )
    .unwrap()
}

/// The digest comes before the replay: the replayed file is a change check 7 expects, so a
/// file the import did not write still shows.
#[test]
fn prepare_digests_the_vault_before_the_replay_and_expects_only_its_writes() {
    let s = Setup::new();
    let path = s.vault("V", Some(&singleton("uuid-v")));
    let dir = PathBuf::from(&path);
    write(&dir, "notes/kept.md", b"kept");
    let replayed = dir.join("notes/sub/replayed.md");
    let journal = journal(json!([
        {"absolutePath": replayed.to_string_lossy(), "content": "body"},
        {"absolutePath": dir.join("bad.md").to_string_lossy(), "content": "x", "sha256": "00"},
        {"absolutePath": s.root.path().join("elsewhere/other.md").to_string_lossy(), "content": "y"},
        {"kind": "rename"},
    ]));
    let config =
        ElectronConfig::parse(json!({"vaults": [{"path": path}]}).to_string().as_bytes()).unwrap();
    let plan = plan_vaults(&s.profile, Some(&config), &s.scratch);
    let ids = ids(&plan, &path);
    let vault = prepare_vault(
        &s.profile,
        Some(&config),
        &path,
        &ids,
        Some(&journal),
        &s.scratch,
    )
    .unwrap();

    assert_eq!(fs::read(&replayed).unwrap(), b"body");
    assert_eq!(vault.tree_before.len(), 2, "notes/ and notes/kept.md only");
    let expected = vault.expected_changes();
    assert_eq!(
        expected.files,
        BTreeSet::from([
            CANVAS_LIBRARY.to_owned(),
            "notes/sub/replayed.md".to_owned()
        ])
    );
    assert_eq!(
        expected.folders,
        BTreeSet::from(["canvases", "notes", "notes/sub"].map(str::to_owned))
    );
    write(&dir, ".memry/core/data.db", b"core");
    write(&dir, CANVAS_LIBRARY, b"{}");
    assert!(vault.unexpected_changes().unwrap().is_empty());
    write(&dir, "notes/kept.md", b"edited");
    assert_eq!(vault.unexpected_changes().unwrap(), ["notes/kept.md"]);

    let report = serde_json::to_value(vault.report()).unwrap();
    assert_eq!(
        report,
        json!({
            "id": {"vaultId": "uuid-v", "minted": false},
            "replay": {
                "written": ["notes/sub/replayed.md"],
                "deleted": [],
                "settled": 0,
                "skipped": [{"index": 1, "path": dir.join("bad.md").to_string_lossy(), "reason": "shaMismatch"}],
                "otherVault": 1,
                "unknown": 1,
            },
            "fold": {
                "docs": 0, "skipped": [], "incomplete": [], "legacy": "absent",
                "previousStoreUnread": false, "ignoredKeys": 0, "tornTails": [],
                "owedCompactions": [],
            },
        })
    );
}

/// A blank uuid names nothing, in `data.db` or in the config; any other value is the id as
/// written, case and spaces included.
#[test]
fn a_blank_uuid_counts_as_absent_and_any_other_is_kept_verbatim() {
    let s = Setup::new();
    let blank_db = s.vault("BlankDb", Some(&singleton("")));
    let blank_config = s.vault("BlankConfig", Some(""));
    let verbatim = s.vault("Verbatim", Some(&singleton(" Mixed-Case ")));
    let plan = s.plan(json!({"vaults": [
        {"path": blank_db, "vaultUuid": "cfg-1"},
        {"path": blank_config, "vaultUuid": "  "},
        {"path": verbatim},
    ]}));
    assert_eq!(ids(&plan, &blank_db).vault_id, "cfg-1");
    assert!(ids(&plan, &blank_config).minted);
    assert_eq!(ids(&plan, &verbatim).vault_id, " Mixed-Case ");
}

/// Only a database that reads wrong is `Unreadable`; one that cannot be reached right now (a
/// copy that fails) waits for the vault's first open.
#[test]
fn a_data_db_that_cannot_be_copied_is_deferred_not_unreadable() {
    let s = Setup::new();
    let path = s.vault("DirDb", None);
    fs::create_dir_all(Path::new(&path).join(".memry/data.db")).unwrap();
    let plan = s.plan(json!({"vaults": [{"path": path}]}));
    assert!(
        matches!(plan.vaults[0].disposition, Disposition::Deferred(_)),
        "{:?}",
        plan.vaults[0].disposition
    );
}

/// The written comparison alone: the profile folder (as the config names it) does not
/// resolve, so only the string comparison can recognise the sandbox in it.
#[test]
fn the_sandbox_is_recognised_by_its_written_path_when_nothing_resolves() {
    let mut s = Setup::new();
    s.profile.dir = s.root.path().join("unmounted").join("memrynote");
    let sandbox = s.profile.dir.join("Sandbox").to_string_lossy().into_owned();
    let plan = s.plan(json!({"vaults": [{"path": sandbox}]}));
    assert!(
        matches!(plan.vaults[0].disposition, Disposition::Sandbox),
        "{:?}",
        plan.vaults[0].disposition
    );
}

#[test]
fn only_the_top_level_memry_folder_is_left_out_of_the_tree() {
    let dir = tempfile::tempdir().unwrap();
    let v = dir.path();
    write(v, "notes/.memry/x.md", b"x");
    let before = VaultTree::read(v).unwrap();
    assert_eq!(before.len(), 3, "{before:?}");
    write(v, "notes/.memry/x.md", b"changed");
    let after = VaultTree::read(v).unwrap();
    assert_eq!(
        after.changed_since(&before, &ExpectedChanges::default()),
        ["notes/.memry/x.md"]
    );
}

/// A FIFO is recorded without being opened: opening one for reading waits for a writer forever.
#[cfg(unix)]
#[test]
fn a_fifo_is_recorded_without_opening_it() {
    let dir = tempfile::tempdir().unwrap();
    let v = dir.path();
    let fifo = std::ffi::CString::new(v.join("pipe").to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let before = VaultTree::read(v).unwrap();
    assert_eq!(before.len(), 1);
    fs::remove_file(v.join("pipe")).unwrap();
    write(v, "pipe", b"");
    let after = VaultTree::read(v).unwrap();
    assert_eq!(
        after.changed_since(&before, &ExpectedChanges::default()),
        ["pipe"]
    );
}

/// A folder the walk cannot list is one opaque entry; the rest of the vault is still read.
#[cfg(unix)]
#[test]
fn an_unreadable_folder_is_one_opaque_entry() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().unwrap();
    let v = dir.path();
    write(v, "locked/a.md", b"a");
    write(v, "open.md", b"o");
    fs::set_permissions(v.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(v.join("locked")).is_ok() {
        // Root reads every folder.
        fs::set_permissions(v.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let tree = VaultTree::read(v);
    fs::set_permissions(v.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    let tree = tree.unwrap();
    assert_eq!(tree.len(), 2, "{tree:?}");
    let readable = VaultTree::read(v).unwrap();
    assert_eq!(
        readable.changed_since(&tree, &ExpectedChanges::default()),
        ["locked", "locked/a.md"]
    );
}

/// A write that failed may have left the folders above its file; those are expected, a file
/// at the failed path is not.
#[test]
fn the_folders_of_a_failed_write_are_expected_and_nothing_else_there() {
    let s = Setup::new();
    let path = s.vault("V", Some(&singleton("uuid-v")));
    let dir = PathBuf::from(&path);
    let config =
        ElectronConfig::parse(json!({"vaults": [{"path": path}]}).to_string().as_bytes()).unwrap();
    let plan = plan_vaults(&s.profile, Some(&config), &s.scratch);
    let ids = ids(&plan, &path);
    let mut vault =
        prepare_vault(&s.profile, Some(&config), &path, &ids, None, &s.scratch).unwrap();
    vault
        .replay
        .skipped
        .push(crate::electron_import::journal_replay::SkippedEntry {
            index: 0,
            path: dir.join("failed/deep/x.md").to_string_lossy().into_owned(),
            reason: crate::electron_import::journal_replay::EntrySkip::WriteFailed(
                std::io::ErrorKind::StorageFull,
            ),
        });
    fs::create_dir_all(dir.join("failed/deep")).unwrap();
    assert_eq!(vault.unexpected_changes().unwrap(), Vec::<String>::new());
    write(&dir, "failed/deep/x.md", b"half");
    assert_eq!(vault.unexpected_changes().unwrap(), ["failed/deep/x.md"]);
}
