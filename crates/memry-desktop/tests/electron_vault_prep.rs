//! Step 37e1 (#3554) over the Electron profile fixture: the vault phase's plan names each vault
//! once with the ids it is imported under, and the preparation replays the journal and folds
//! the store with them, leaving the Electron data as it found it.

use std::fs;
use std::path::Path;

use memry_desktop::electron_import::journal_replay::{BulkApplyJournal, EntrySkip};
use memry_desktop::electron_import::profile::{locate_profile, vault_dir_name};
use memry_desktop::electron_import::vault_prep::{
    CANVAS_LIBRARY, Disposition, VaultIds, VaultPlan, plan_vaults, prepare_vault,
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

    fn legacy(&self, path: &Path, ids: &VaultIds) -> LegacyStore {
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

fn import_ids(plan: &VaultPlan, path: &Path) -> VaultIds {
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
    assert_eq!(ids.store_uuid, f.expected.vault_uuid);
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
