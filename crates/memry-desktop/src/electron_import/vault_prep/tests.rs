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

fn ids(plan: &VaultPlan, path: &str) -> VaultIds {
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

/// The core id is the singleton's (Step 36 imports that row byte for byte); the store is the
/// one Electron opened, named by the config uuid first (`fold_vault_store`'s contract).
#[test]
fn each_vault_resolves_its_core_id_and_its_store_uuid_once() {
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
        let ids = ids(&plan, path);
        (ids.vault_id, ids.store_uuid, ids.minted)
    };
    assert_eq!(pair(&both), ("from-db".into(), "from-config".into(), false));
    assert_eq!(
        pair(&config_only),
        ("config-only".into(), "config-only".into(), false)
    );
    assert_eq!(pair(&db_only), ("db-only".into(), "db-only".into(), false));
    let (vault_id, store_uuid, minted) = pair(&neither);
    assert!(minted);
    assert_eq!(vault_id, store_uuid);
    let parsed = uuid::Uuid::parse_str(&vault_id).unwrap();
    assert_eq!(parsed.get_version_num(), 4);
    assert_eq!(vault_id, parsed.to_string(), "lowercase, as randomUUID");
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
    let expected: BTreeSet<String> = ["replayed".to_owned(), "replayed/e.md".to_owned()].into();
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
    assert!(after.changed_since(&before, &BTreeSet::new()).is_empty());
    fs::remove_file(v.join("out")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("elsewhere"), v.join("out")).unwrap();
    let moved = VaultTree::read(v).unwrap();
    assert_eq!(moved.changed_since(&before, &BTreeSet::new()), ["out"]);
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
    assert_eq!(
        vault.expected_changes(),
        [
            "canvases",
            CANVAS_LIBRARY,
            "notes",
            "notes/sub",
            "notes/sub/replayed.md"
        ]
        .map(str::to_owned)
        .into()
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
            "ids": {"vaultId": "uuid-v", "storeUuid": "uuid-v", "minted": false},
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
