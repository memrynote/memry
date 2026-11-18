//! Step 37e1 (#3554) over the Electron profile fixture: the vault phase's plan names each vault
//! once with the ids it is imported under, and the preparation replays the journal and folds
//! the store with them, leaving the Electron data as it found it.

use std::fs;
use std::path::Path;

use memry_desktop::electron_import::journal_replay::{BulkApplyJournal, EntrySkip};
use memry_desktop::electron_import::profile::{locate_profile, vault_dir_name};
use memry_desktop::electron_import::vault_prep::{
    CANVAS_LIBRARY, Disposition, VaultId, VaultPlan, plan_vaults, prepare_vault,
};
use memry_desktop::electron_import::ystore_import::LegacyStore;
use memry_desktop::electron_import::{ElectronConfig, ElectronProfile, Scratch};
use rusqlite::Connection;

use crate::electron_profile::ElectronProfileFixture;

struct Run {
    profile: ElectronProfile,
    config: ElectronConfig,
    scratch: Scratch,
}

fn run(f: &ElectronProfileFixture) -> Run {
    let profile = locate_profile(&f.profile_env()).unwrap().unwrap();
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    Run {
        profile,
        config,
        scratch: Scratch::new(f.scratch_root()).unwrap(),
    }
}

impl Run {
    fn plan(&self) -> VaultPlan {
        plan_vaults(&self.profile, Some(&self.config), &self.scratch)
    }

    fn legacy(&self, path: &Path, ids: &VaultId) -> LegacyStore {
        let path = path.to_string_lossy();
        prepare_vault(
            &self.profile,
            Some(&self.config),
            &path,
            ids,
            None,
            &self.scratch,
        )
        .unwrap()
        .fold
        .legacy
    }
}

fn import_ids(plan: &VaultPlan, path: &Path) -> VaultId {
    let path = path.to_string_lossy();
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
fn the_fixture_vault_is_planned_and_prepared_and_electron_is_untouched() {
    let f = ElectronProfileFixture::install();
    let before = f.snapshot();
    let r = run(&f);
    let plan = r.plan();
    assert_eq!(plan.vaults.len(), 1);
    assert!(plan.vaults[0].current);
    let ids = import_ids(&plan, &f.vault);
    assert_eq!(ids.vault_id, f.expected.vault_uuid, "the data.db singleton");
    assert!(!ids.minted);

    let journal = BulkApplyJournal::read(&r.profile).unwrap().unwrap();
    let path = f.vault.to_string_lossy();
    let vault = prepare_vault(
        &r.profile,
        Some(&r.config),
        &path,
        &ids,
        Some(&journal),
        &r.scratch,
    )
    .unwrap();
    assert!(!vault.replay.written.is_empty());
    assert!(
        vault
            .replay
            .skipped
            .iter()
            .any(|s| s.reason == EntrySkip::ShaMismatch)
    );
    assert!(
        vault
            .fold
            .docs
            .iter()
            .any(|d| d.doc_id == f.expected.offline_doc_id)
    );
    assert_eq!(vault.fold.legacy, LegacyStore::LeftUnread);
    assert_eq!(
        f.snapshot(),
        before,
        "profile, data.db and index.db unchanged"
    );

    // What Step 36's install writes is expected; any other change fails check 7.
    let core = f.vault.join(".memry").join("core");
    fs::create_dir_all(&core).unwrap();
    fs::write(core.join("data.db"), b"core").unwrap();
    let library = f.vault.join(CANVAS_LIBRARY);
    fs::create_dir_all(library.parent().unwrap()).unwrap();
    fs::write(&library, b"{}").unwrap();
    assert_eq!(vault.unexpected_changes().unwrap(), Vec::<String>::new());

    let report = serde_json::to_string(&vault.report()).unwrap();
    assert!(report.contains("\"shaMismatch\""), "{report}");
    assert!(
        !report.contains("Edited offline"),
        "no note text in the report"
    );
}

/// A vault named nowhere gets a minted uuid in the plan; the legacy store pick, which names the
/// other vaults through the same reader, agrees with it, so exactly one vault reads the store.
#[test]
fn planned_ids_give_an_unclaimed_legacy_store_to_exactly_one_vault() {
    let f = ElectronProfileFixture::install();
    let other = f.vault.parent().unwrap().join("Other");
    fs::create_dir_all(other.join(".memry")).unwrap();
    Connection::open(other.join(".memry").join("data.db"))
        .unwrap()
        .execute_batch("CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid TEXT);")
        .unwrap();
    fs::remove_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(&f.expected.vault_uuid)),
    )
    .unwrap();
    let config_path = f.profile.join("memry-config.json");
    let edit = |current: &Path| {
        let mut c: serde_json::Value =
            serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
        c["currentVault"] = current.to_string_lossy().into();
        let vaults = c["vaults"].as_array_mut().unwrap();
        vaults.truncate(1);
        vaults.push(serde_json::json!({ "path": other.to_string_lossy(), "name": "Other" }));
        fs::write(&config_path, serde_json::to_vec_pretty(&c).unwrap()).unwrap();
    };

    for (current, reader) in [(&other, "other"), (&f.vault, "fixture")] {
        edit(current);
        let r = run(&f);
        let plan = r.plan();
        let theirs = import_ids(&plan, &other);
        assert!(theirs.minted);
        let mut readers = Vec::new();
        if r.legacy(&f.vault, &import_ids(&plan, &f.vault)) == LegacyStore::Read {
            readers.push("fixture");
        }
        if r.legacy(&other, &theirs) == LegacyStore::Read {
            readers.push("other");
        }
        assert_eq!(readers, [reader]);
    }
}

const CONFIG_ONLY: &str = "2f6a1c3e-0d4b-4e8a-9c7f-1b2d3e4f5a60";

fn edit_config(f: &ElectronProfileFixture, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = f.profile.join("memry-config.json");
    let mut c: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(&mut c);
    fs::write(&path, serde_json::to_vec_pretty(&c).unwrap()).unwrap();
}

/// Electron names the store by the `vault_metadata` singleton (`crdt-store-path.ts:51-57`); a
/// config `vaultUuid` left behind by an adoption whose registration failed names nothing.
#[test]
fn the_store_read_is_the_one_the_singleton_names_over_the_config_uuid() {
    let f = ElectronProfileFixture::install();
    edit_config(&f, |c| c["vaults"][0]["vaultUuid"] = CONFIG_ONLY.into());
    let r = run(&f);
    let ids = import_ids(&r.plan(), &f.vault);
    assert_eq!(ids.vault_id, f.expected.vault_uuid);
    let path = f.vault.to_string_lossy();
    let vault = prepare_vault(&r.profile, Some(&r.config), &path, &ids, None, &r.scratch).unwrap();
    assert!(
        vault
            .fold
            .docs
            .iter()
            .any(|d| d.doc_id == f.expected.offline_doc_id)
    );
    assert_eq!(vault.fold.legacy, LegacyStore::LeftUnread);
}

/// `recordCrdtStoreRename` moves `legacyStoreClaimedBy` to the new singleton: the claim names
/// the singleton, and the vault without its own store reads the legacy store.
#[test]
fn a_legacy_claim_naming_the_singleton_is_this_vault_s() {
    let f = ElectronProfileFixture::install();
    fs::remove_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(&f.expected.vault_uuid)),
    )
    .unwrap();
    edit_config(&f, |c| c["vaults"][0]["vaultUuid"] = CONFIG_ONLY.into());
    let r = run(&f);
    let ids = import_ids(&r.plan(), &f.vault);
    assert_eq!(r.legacy(&f.vault, &ids), LegacyStore::Read);
}

/// The legacy pick names the other vaults the same way: `Other`'s config uuid is stale, its
/// singleton names a store, so `Other` (current) has a store and the fixture vault inherits.
#[test]
fn the_legacy_pick_names_other_vaults_by_their_singleton() {
    let f = ElectronProfileFixture::install();
    let other = f.vault.parent().unwrap().join("Other");
    fs::create_dir_all(other.join(".memry")).unwrap();
    Connection::open(other.join(".memry").join("data.db"))
        .unwrap()
        .execute_batch(&format!(
            "CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid TEXT);
             INSERT INTO vault_metadata VALUES ('singleton', '{OTHER_SINGLETON}');"
        ))
        .unwrap();
    fs::create_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(OTHER_SINGLETON)),
    )
    .unwrap();
    fs::remove_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(&f.expected.vault_uuid)),
    )
    .unwrap();
    let other_path = other.to_string_lossy().into_owned();
    edit_config(&f, |c| {
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
        c["currentVault"] = other_path.clone().into();
        c["vaults"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "path": other_path, "vaultUuid": CONFIG_ONLY }));
    });
    let r = run(&f);
    let ids = import_ids(&r.plan(), &f.vault);
    assert_eq!(r.legacy(&f.vault, &ids), LegacyStore::Read);
}

const OTHER_SINGLETON: &str = "7a9e3b1c-5d2f-4c6a-8e0b-9f1a2b3c4d5e";

/// A `currentVault` the config's `vaults[]` does not list (a partial or edited config) is still
/// imported, so it counts in the legacy pick: one listed vault plus it are two vaults, and only
/// one of them reads the unclaimed legacy store.
#[test]
fn an_unlisted_current_vault_and_the_one_listed_vault_have_one_legacy_reader() {
    let f = ElectronProfileFixture::install();
    let other = f.vault.parent().unwrap().join("Other");
    fs::create_dir_all(other.join(".memry")).unwrap();
    Connection::open(other.join(".memry").join("data.db"))
        .unwrap()
        .execute_batch(&format!(
            "CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid TEXT);
             INSERT INTO vault_metadata VALUES ('singleton', '{OTHER_SINGLETON}');"
        ))
        .unwrap();
    fs::remove_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(&f.expected.vault_uuid)),
    )
    .unwrap();
    let other_path = other.to_string_lossy().into_owned();
    edit_config(&f, |c| {
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
        c["currentVault"] = other_path.into();
    });
    let r = run(&f);
    let plan = r.plan();
    assert_eq!(plan.vaults.len(), 2);
    let mut readers = Vec::new();
    for (name, path) in [("listed", &f.vault), ("current", &other)] {
        if r.legacy(path, &import_ids(&plan, path)) == LegacyStore::Read {
            readers.push(name);
        }
    }
    assert_eq!(readers, ["current"]);
}
