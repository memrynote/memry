//! Step 37d (#3554) over the Electron profile fixture: the vault's y-leveldb store folds into
//! one full-state update per document, the legacy global store is read only when the vault has
//! none of its own, and the bulk-apply journal lands its pending note files in the vault. None
//! of it changes the Electron data.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use memry_desktop::electron_import::journal_replay::{BulkApplyJournal, EntrySkip, replay};
use memry_desktop::electron_import::profile::{locate_profile, vault_dir_name};
use memry_desktop::electron_import::ystore_import::{
    LegacyStore, SkipReason, YStoreFold, fold_vault_store,
};
use memry_desktop::electron_import::{ElectronConfig, ElectronProfile, Scratch};
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, GetString as _, Transact as _, Update, WriteTxn as _};

use crate::electron_profile::{ElectronProfileFixture, tree_hash};

fn located(f: &ElectronProfileFixture) -> ElectronProfile {
    locate_profile(&f.profile_env())
        .unwrap()
        .expect("the fixture is an installed profile")
}

fn fold(f: &ElectronProfileFixture) -> YStoreFold {
    fold_as(f, &f.vault, &f.expected.vault_uuid)
}

/// Folds the vault at `vault`, the path its config entry records, named `vault_uuid`.
fn fold_as(f: &ElectronProfileFixture, vault: &Path, vault_uuid: &str) -> YStoreFold {
    let profile = located(f);
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    let scratch = Scratch::new(f.scratch_root()).unwrap();
    let path = vault.to_string_lossy();
    fold_vault_store(&profile, &path, vault_uuid, Some(&config), &scratch).unwrap()
}

/// The body of a folded document, as the editor reads it.
fn body(state: &[u8]) -> String {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    txn.apply_update(Update::decode_v1(state).unwrap()).unwrap();
    txn.get_or_insert_xml_fragment("prosemirror")
        .get_string(&txn)
}

#[test]
fn the_vault_store_folds_every_note_and_leaves_the_legacy_store_unread() {
    let f = ElectronProfileFixture::install();
    let e = &f.expected;
    let before = f.snapshot();
    let out = fold(&f);

    let ids: BTreeSet<&str> = out.docs.iter().map(|d| d.doc_id.as_str()).collect();
    let mut want: BTreeSet<&str> = e.notes.iter().map(|n| n.id.as_str()).collect();
    want.remove(e.legacy_doc_id.as_str());
    want.insert(&e.deleted_doc_id);
    assert_eq!(ids, want);

    let offline = out
        .docs
        .iter()
        .find(|d| d.doc_id == e.offline_doc_id)
        .unwrap();
    assert_eq!(offline.watermark, Some(e.watermark.applied_sequence));
    let text = body(&offline.state);
    assert!(text.contains("This paragraph was synced."), "{text}");
    assert!(text.contains("Edited offline, never pushed."), "{text}");
    for doc in &out.docs {
        assert!(!body(&doc.state).is_empty(), "{}", doc.doc_id);
    }

    let skipped: Vec<(&str, SkipReason)> = out
        .skipped
        .iter()
        .map(|s| (s.doc_id.as_str(), s.reason))
        .collect();
    assert_eq!(skipped.len(), 3, "{skipped:?}");
    assert!(skipped.contains(&(e.unattributable_doc_id.as_str(), SkipReason::Unattributable)));
    assert_eq!(
        skipped
            .iter()
            .filter(|(id, reason)| id.starts_with("__memry_")
                && !id.starts_with("__memry_unattributable__/")
                && *reason == SkipReason::Reserved)
            .count(),
        2
    );
    assert_eq!(out.legacy, LegacyStore::LeftUnread);
    // Electron settled the marker: it holds `[]`.
    assert!(out.owed_compactions.is_empty());
    assert!(!out.previous_store_unread);
    assert!(out.incomplete.is_empty());
    assert_eq!(f.snapshot(), before);
}

#[test]
fn a_claimed_legacy_store_is_read_when_the_vault_has_none_of_its_own() {
    let f = ElectronProfileFixture::install();
    fs::remove_dir_all(f.profile.join("crdt-stores").join(&f.expected.vault_uuid)).unwrap();
    let before = f.snapshot();
    let out = fold(&f);
    assert_eq!(out.legacy, LegacyStore::Read);
    let ids: Vec<&str> = out.docs.iter().map(|d| d.doc_id.as_str()).collect();
    assert_eq!(ids, [f.expected.legacy_doc_id.as_str()]);
    let text = body(&out.docs[0].state);
    assert!(text.contains("Written by another program."), "{text}");
    assert_eq!(f.snapshot(), before);
}

/// Rewrites the fixture's `memry-config.json` through `edit`.
fn edit_config(f: &ElectronProfileFixture, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = f.profile.join("memry-config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(&mut config);
    fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
}

/// A profile whose last Electron run predates per-vault stores: the legacy store is unclaimed
/// and the vault has no store of its own, so Electron's next launch would hand it to this
/// vault (`inheritLegacyCrdtStore`).
#[test]
fn an_unclaimed_legacy_store_is_read_when_the_vault_has_none_of_its_own() {
    let f = ElectronProfileFixture::install();
    fs::remove_dir_all(f.profile.join("crdt-stores").join(&f.expected.vault_uuid)).unwrap();
    edit_config(&f, |c| {
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
    });
    let before = f.snapshot();
    let out = fold(&f);
    assert_eq!(out.legacy, LegacyStore::Read);
    let ids: Vec<&str> = out.docs.iter().map(|d| d.doc_id.as_str()).collect();
    assert_eq!(ids, [f.expected.legacy_doc_id.as_str()]);
    assert!(
        out.skipped
            .iter()
            .all(|s| s.reason != SkipReason::AmbiguousLegacy)
    );
    assert_eq!(f.snapshot(), before);
}

/// With more than one vault, the store Electron would inherit may hold other vaults' journal
/// days, so it owes a partition and those days are set aside.
#[test]
fn an_unclaimed_legacy_store_owes_a_partition_when_there_are_other_vaults() {
    let f = ElectronProfileFixture::install();
    let legacy = f.profile.join("crdt-store");
    fs::remove_dir_all(&legacy).unwrap();
    fs::rename(
        f.profile.join("crdt-stores").join(&f.expected.vault_uuid),
        &legacy,
    )
    .unwrap();
    edit_config(&f, |c| {
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
        c["vaults"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "path": "/elsewhere/Other", "name": "Other" }));
    });
    let out = fold(&f);
    assert_eq!(out.legacy, LegacyStore::Read);
    assert!(
        out.docs
            .iter()
            .all(|d| d.doc_id != f.expected.journal_doc_id)
    );
    assert!(
        out.skipped
            .iter()
            .any(|s| s.doc_id == f.expected.journal_doc_id
                && s.reason == SkipReason::AmbiguousLegacy)
    );
}

/// The fixture vault without its own store plus a second vault `Other` (an empty folder, no
/// store), and a legacy store nobody claimed. `stamp_ours`: the fixture's config entry keeps its
/// `vaultUuid` (its `data.db` holds the uuid either way). Returns `Other`'s path.
fn two_vaults_without_stores(
    f: &ElectronProfileFixture,
    other_uuid: Option<&str>,
    stamp_ours: bool,
) -> PathBuf {
    let other = f.vault.parent().unwrap().join("Other");
    fs::create_dir_all(&other).unwrap();
    fs::remove_dir_all(
        f.profile
            .join("crdt-stores")
            .join(vault_dir_name(&f.expected.vault_uuid)),
    )
    .unwrap();
    edit_config(f, |c| {
        c["crdtStore"]
            .as_object_mut()
            .unwrap()
            .remove("legacyStoreClaimedBy");
        if !stamp_ours {
            c["vaults"][0].as_object_mut().unwrap().remove("vaultUuid");
        }
        let mut entry = serde_json::json!({ "path": other.to_string_lossy(), "name": "Other" });
        if let Some(uuid) = other_uuid {
            entry["vaultUuid"] = uuid.into();
        }
        c["vaults"].as_array_mut().unwrap().push(entry);
    });
    other
}

const OTHER: &str = "0b5b6f39-8d0e-4c51-9a57-3f1f2b7c9d10";
/// The uuid the import mints for a vault that has none anywhere.
const MINTED: &str = "5d0c7a52-61f4-4b0e-8a6c-0f3e9b2d7c41";

fn set_current_vault(f: &ElectronProfileFixture, path: &Path) {
    let path = path.to_string_lossy().into_owned();
    edit_config(f, |c| c["currentVault"] = path.into());
}

/// Electron hands an unclaimed legacy store to the next vault the user opens, which the import
/// cannot know: it picks `currentVault` when that vault has no store, else the first vault in
/// config order without one, so no legacy document lands in two vaults.
#[test]
fn an_unclaimed_legacy_store_is_read_by_exactly_one_vault() {
    let f = ElectronProfileFixture::install();
    let ours = f.expected.vault_uuid.clone();
    let other = two_vaults_without_stores(&f, Some(OTHER), true);
    assert_eq!(fold(&f).legacy, LegacyStore::Read);
    assert_eq!(fold_as(&f, &other, OTHER).legacy, LegacyStore::LeftUnread);

    set_current_vault(&f, &other);
    assert_eq!(fold(&f).legacy, LegacyStore::LeftUnread);
    assert_eq!(fold_as(&f, &other, OTHER).legacy, LegacyStore::Read);

    // The current vault has a store of its own: the first vault in config order without one.
    fs::create_dir_all(f.profile.join("crdt-stores").join(vault_dir_name(OTHER))).unwrap();
    assert_eq!(fold_as(&f, &f.vault, &ours).legacy, LegacyStore::Read);
}

/// A profile whose last Electron run predates config `vaultUuid` (#510): `currentVault` is
/// picked by its path, and each vault is named by its `data.db` uuid or the one the import
/// mints.
#[test]
fn without_any_config_uuid_the_current_vault_reads_the_legacy_store() {
    let f = ElectronProfileFixture::install();
    let other = two_vaults_without_stores(&f, None, false);
    assert_eq!(fold(&f).legacy, LegacyStore::Read);
    assert_eq!(fold_as(&f, &other, MINTED).legacy, LegacyStore::LeftUnread);

    set_current_vault(&f, &other);
    assert_eq!(fold_as(&f, &other, MINTED).legacy, LegacyStore::Read);
    assert_eq!(fold(&f).legacy, LegacyStore::LeftUnread);
}

/// `currentVault`'s stamp failed (`vault/index.ts:972-980` logs and goes on) while another
/// vault has a uuid and no store: the current vault still reads it.
#[test]
fn a_current_vault_missing_its_stamp_still_reads_the_legacy_store() {
    let f = ElectronProfileFixture::install();
    let other = two_vaults_without_stores(&f, Some(OTHER), false);
    assert_eq!(fold(&f).legacy, LegacyStore::Read);
    assert_eq!(fold_as(&f, &other, OTHER).legacy, LegacyStore::LeftUnread);
}

#[test]
fn an_owed_partition_sets_the_journal_day_aside() {
    let f = ElectronProfileFixture::install();
    let uuid = f.expected.vault_uuid.clone();
    edit_config(&f, |c| {
        c["crdtStore"]["legacyStorePartitionPendingFor"] = serde_json::Value::String(uuid);
    });
    let out = fold(&f);
    assert!(
        out.docs
            .iter()
            .all(|d| d.doc_id != f.expected.journal_doc_id)
    );
    assert!(
        out.skipped
            .iter()
            .any(|s| s.doc_id == f.expected.journal_doc_id
                && s.reason == SkipReason::AmbiguousLegacy)
    );
    assert_eq!(
        out.docs.len(),
        fold(&ElectronProfileFixture::install()).docs.len() - 1
    );
}

#[test]
fn the_journal_lands_its_verified_writes_once() {
    let f = ElectronProfileFixture::install();
    let profile = located(&f);
    let before = f.snapshot();
    let vault_before = tree_hash(&f.vault);
    let journal = BulkApplyJournal::read(&profile).unwrap().unwrap();
    assert!(journal.unknown.is_empty());

    let first = replay(&journal, &f.vault);
    let notes = f.vault.join("notes");
    assert_eq!(
        first.written,
        [notes.join("Replayed one.md"), notes.join("Replayed two.md")]
    );
    assert!(first.deleted.is_empty());
    assert_eq!((first.settled, first.other_vault), (0, 0));
    assert_eq!(first.skipped.len(), 1);
    assert_eq!(first.skipped[0].reason, EntrySkip::ShaMismatch);
    assert!(first.skipped[0].path.ends_with("Torn.md"));
    assert!(!notes.join("Torn.md").exists());

    let recorded: serde_json::Value = serde_json::from_slice(
        &fs::read(profile.dir.join("sync-bulk-apply-journal.json")).unwrap(),
    )
    .unwrap();
    for entry in &recorded["entries"].as_array().unwrap()[..2] {
        let path = std::path::Path::new(entry["absolutePath"].as_str().unwrap());
        assert_eq!(
            hex::encode(Sha256::digest(fs::read(path).unwrap())),
            entry["sha256"].as_str().unwrap()
        );
    }
    let mut vault_after = tree_hash(&f.vault);
    for name in ["notes/Replayed one.md", "notes/Replayed two.md"] {
        assert!(vault_after.remove(name).is_some(), "{name}");
    }
    assert_eq!(vault_after, vault_before);
    assert_eq!(f.snapshot(), before);

    let second = replay(&journal, &f.vault);
    assert!(second.written.is_empty());
    assert_eq!(second.settled, 2);
    assert_eq!(second.skipped, first.skipped);
    assert_eq!(f.snapshot(), before);
}
