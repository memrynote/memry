//! Step 37d (#3554) over the Electron profile fixture: the vault's y-leveldb store folds into
//! one full-state update per document, the legacy global store is read only when the vault has
//! none of its own, and the bulk-apply journal lands its pending note files in the vault. None
//! of it changes the Electron data.

use std::collections::BTreeSet;
use std::fs;

use memry_desktop::electron_import::journal_replay::{BulkApplyJournal, EntrySkip, replay};
use memry_desktop::electron_import::profile::locate_profile;
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
    let profile = located(f);
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    let scratch = Scratch::new(f.scratch_root()).unwrap();
    fold_vault_store(&profile, &f.expected.vault_uuid, Some(&config), &scratch).unwrap()
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
