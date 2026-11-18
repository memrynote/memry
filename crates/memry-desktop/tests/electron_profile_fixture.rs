//! The Electron profile fixture (`tests/fixtures/electron-profile`, Step 37a #3554) reads like a
//! profile a user's Electron install left behind: the Step 06 readers find and decrypt it, its
//! parts agree with each other the way one install's parts do (the secrets unlock the vault's
//! verifiers, every note has its Yjs document), and reading it changes nothing.

use std::collections::BTreeSet;
use std::fs;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::StorageError;
use memry_core::crypto::keys::{account_key_verifier, derive_vault_key, local_vault_key_verifier};
use memry_core::storage::open_data;
use memry_desktop::electron_import::profile::locate_profile;
use memry_desktop::electron_import::secrets::{NoKeytar, read_all_secrets};
use memry_desktop::electron_import::ystore::{STORE_DOC, SnapshotWatermark};
use memry_desktop::electron_import::{
    CustomDictionary, ElectronConfig, ElectronProfile, LocalStorageSnapshot, ProfileLock, Scratch,
    YStoreReader,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, GetString as _, Transact as _, Update, WriteTxn as _};

use crate::electron_profile::ElectronProfileFixture;

const OWED_COMPACTIONS_DOC: &str = "__memry_owed_compactions__";

fn located(f: &ElectronProfileFixture) -> ElectronProfile {
    locate_profile(&f.profile_env())
        .unwrap()
        .expect("the fixture is an installed profile")
}

fn read_only(path: &std::path::Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn setting(db: &Connection, key: &str) -> String {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .unwrap()
}

/// The body text of a stored document: every update folded in clock order, as Electron's
/// y-leveldb `getYDoc` does.
fn fold(updates: &[(u32, &[u8])]) -> String {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    for (_, update) in updates {
        txn.apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }
    txn.get_or_insert_xml_fragment("prosemirror")
        .get_string(&txn)
}

#[test]
fn the_fixture_is_found_where_an_installed_app_keeps_it() {
    let f = ElectronProfileFixture::install();
    let profile = located(&f);
    assert_eq!(profile.dir, f.profile);
    assert!(profile.has_config && profile.has_secure_store && profile.has_local_state);
    assert!(profile.has_local_storage && profile.has_legacy_crdt_store);
    assert!(profile.has_custom_dictionary);
    assert_eq!(profile.pin.as_ref().map(|p| p.app_name), Some("memrynote"));
    assert_eq!(
        profile.crdt_store_dirs,
        vec![f.profile.join("crdt-stores").join(&f.expected.vault_uuid)]
    );
    assert!(profile.other_candidates.is_empty());
    ProfileLock::probe(&profile).unwrap();
    // The userData files the migration decides on one by one (Step 37 "Renderer state,
    // dictionary, models, config"): carried, or deliberately left behind.
    for rel in [
        "telemetry.json",
        "models/transformers/onnx-community/fixture-model/onnx/model.onnx",
        "models/voice-transcription/whisper-small.json",
        "ocr-languages/deu.traineddata",
        "sync-packs/pack-fixture.bin",
        "Sandbox/Welcome.md",
        "sandbox-vault.json",
        "update-install-attempt.json",
        "update-install-health.json",
        "pending-update-install.json",
        "crdt-pending-notes.json",
        "sync-bulk-apply-journal.json",
    ] {
        assert!(f.profile.join(rel).is_file(), "{rel}");
    }
}

#[test]
fn the_config_names_the_copied_vault() {
    let f = ElectronProfileFixture::install();
    let config = ElectronConfig::read(&located(&f)).unwrap().unwrap();
    let (vaults, skipped) = config.vaults();
    assert_eq!(skipped, 0);
    assert_eq!(vaults.len(), 1, "the Sandbox stays out of vaults[]");
    assert_eq!(vaults[0].path, f.vault.to_string_lossy());
    assert_eq!(
        vaults[0].vault_uuid.as_deref(),
        Some(&*f.expected.vault_uuid)
    );
    assert_eq!(config.current_vault(), Some(&*f.vault.to_string_lossy()));
    assert_eq!(config.device_id(), Some(&*f.expected.device_id));
    assert_eq!(config.recovery_phrase_confirmed(), Some(true));
    assert_eq!(
        config.legacy_store_claimed_by(),
        Some(&*f.expected.vault_uuid)
    );
    assert!(config.section("futureSetting").is_some());
    assert!(f.vault.join(".memry").join("data.db").is_file());
}

#[test]
fn every_secret_decrypts_and_unlocks_this_vault() {
    let f = ElectronProfileFixture::install();
    let profile = located(&f);
    let report = read_all_secrets(&profile, &f.key_source(), &NoKeytar).unwrap();
    assert!(report.unreadable.is_empty(), "{:?}", report.unreadable);
    let mut seen = 0;
    for (service, accounts) in f.expected.plaintexts.as_object().unwrap() {
        for (account, value) in accounts.as_object().unwrap() {
            assert_eq!(
                report.get(service, account),
                value.as_str(),
                "{service}/{account}"
            );
            seen += 1;
        }
    }
    assert_eq!(report.entries.len(), seen);

    // One install's parts agree: the master key derives the account verifier in the config and
    // the local verifier in the vault, and the device key is the vault's current device.
    let master = STANDARD
        .decode(report.get("com.memry.sync", "master-key").unwrap())
        .unwrap();
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    assert_eq!(
        config.account_key_verifier(),
        Some(&*account_key_verifier(&master).unwrap())
    );
    assert_eq!(
        f.expected.account_key_verifier,
        account_key_verifier(&master).unwrap()
    );
    let db = read_only(&f.data_db());
    let uuid: String = db
        .query_row("SELECT vault_uuid FROM vault_metadata", [], |r| r.get(0))
        .unwrap();
    assert_eq!(uuid, f.expected.vault_uuid);
    let vault_key = derive_vault_key(&master).unwrap();
    assert_eq!(
        setting(&db, "vault.crypto.verifier.v1"),
        local_vault_key_verifier(&vault_key, &uuid).unwrap()
    );
    let signing = STANDARD
        .decode(report.get("com.memry.sync", "device-signing-key").unwrap())
        .unwrap();
    assert_eq!(signing.len(), 64, "libsodium Ed25519 secret key");
    let (device, public): (String, String) = db
        .query_row(
            "SELECT id, signing_public_key FROM sync_devices WHERE is_current_device = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(device, f.expected.device_id);
    assert_eq!(STANDARD.decode(public).unwrap(), signing[32..]);
}

#[test]
fn every_note_has_its_document_in_the_crdt_stores() {
    let f = ElectronProfileFixture::install();
    let profile = located(&f);
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    let scratch = Scratch::new(f.scratch_root()).unwrap();
    let store = YStoreReader::open(&profile, &f.expected.vault_uuid, Some(&config), &scratch)
        .unwrap()
        .unwrap();
    assert_eq!(store.ignored_keys(), 0);
    assert!(store.torn_tails().is_empty());
    assert_eq!(store.store_epoch(), Some("epoch-fixture-1"));

    let e = &f.expected;
    let db = read_only(&f.data_db());
    let rows: BTreeSet<String> = db
        .prepare("SELECT id FROM note_metadata")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows, e.notes.iter().map(|n| n.id.clone()).collect());
    assert!(rows.contains(&e.journal_doc_id) && e.journal_doc_id.starts_with('j'));
    let mut want: BTreeSet<String> = rows.clone();
    want.remove(&e.legacy_doc_id);
    want.extend([
        e.deleted_doc_id.clone(),
        e.unattributable_doc_id.clone(),
        STORE_DOC.to_owned(),
        OWED_COMPACTIONS_DOC.to_owned(),
    ]);
    let names: BTreeSet<String> = store.doc_names().into_iter().collect();
    assert_eq!(names, want);

    for id in rows.iter().filter(|id| **id != e.legacy_doc_id) {
        assert!(!fold(&store.updates(id)).is_empty(), "{id}");
    }
    // Synced up to the watermark, then edited offline: two updates, the second one unpushed.
    let offline = store.updates(&e.offline_doc_id);
    assert_eq!(offline.len(), 2);
    let text = fold(&offline);
    assert!(text.contains("This paragraph was synced."), "{text}");
    assert!(text.contains("Edited offline, never pushed."), "{text}");
    assert_eq!(
        store.watermark(&e.offline_doc_id),
        Some(SnapshotWatermark {
            applied_sequence: e.watermark.applied_sequence,
            snapshot_revision: Some(e.watermark.snapshot_revision.clone()),
        })
    );
    assert!(store.watermark(&e.journal_doc_id).is_none());

    let legacy = YStoreReader::open_legacy(&profile, &scratch)
        .unwrap()
        .unwrap();
    assert_eq!(legacy.doc_names(), vec![e.legacy_doc_id.clone()]);
    assert!(fold(&legacy.updates(&e.legacy_doc_id)).contains("Written by another program."));
}

#[test]
fn the_vault_databases_are_the_ones_electron_wrote() {
    let f = ElectronProfileFixture::install();
    for path in [f.data_db(), f.index_db()] {
        let db = read_only(&path);
        let check: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(check, "ok", "{}", path.display());
        let migrations: i64 = db
            .query_row("SELECT count(*) FROM __drizzle_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(migrations > 0, "{}", path.display());
    }
    // The core refuses Electron's drizzle schema: the import is the only way in.
    assert!(matches!(
        open_data(&f.data_db()),
        Err(StorageError::ForeignSchema { .. })
    ));
    for note in &f.expected.notes {
        let file = note.path.split('/').fold(f.vault.clone(), |p, s| p.join(s));
        assert!(file.is_file(), "{}", note.path);
    }
    let db = read_only(&f.data_db());
    let count = |sql: &str| -> i64 { db.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT count(*) FROM tasks WHERE repeat_config IS NOT NULL"),
        1
    );
    assert_eq!(count("SELECT count(*) FROM projects"), 2);
    assert_eq!(count("SELECT count(*) FROM inbox_items"), 1);
    assert_eq!(count("SELECT count(*) FROM sync_queue"), 1);
    assert_eq!(
        db.query_row("SELECT item_id FROM sync_pending_deletes", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        f.expected.deleted_doc_id
    );
}

#[test]
fn the_renderer_state_and_dictionary_read_back() {
    let f = ElectronProfileFixture::install();
    let profile = located(&f);
    let scratch = Scratch::new(f.scratch_root()).unwrap();
    let snapshot = LocalStorageSnapshot::read(&profile, "file://", &scratch)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.skipped, 0);
    assert_eq!(snapshot.entries.len(), 4);
    assert_eq!(snapshot.entries["memry.unicode"], "日本語 ✓ fixture");
    let dictionary = CustomDictionary::read(&profile).unwrap().unwrap();
    assert!(dictionary.checksum_ok);
    assert_eq!(dictionary.words.len(), 3);
}

#[test]
fn the_bulk_apply_journal_points_into_the_vault() {
    let f = ElectronProfileFixture::install();
    let journal: Value =
        serde_json::from_slice(&fs::read(f.profile.join("sync-bulk-apply-journal.json")).unwrap())
            .unwrap();
    let entries = journal["entries"].as_array().unwrap();
    let matches: Vec<bool> = entries
        .iter()
        .map(|entry| {
            let path = std::path::Path::new(entry["absolutePath"].as_str().unwrap());
            assert!(path.starts_with(&f.vault), "{}", path.display());
            assert!(!path.exists(), "the write is still pending");
            let digest = Sha256::digest(entry["content"].as_str().unwrap().as_bytes());
            hex::encode(digest) == entry["sha256"].as_str().unwrap()
        })
        .collect();
    assert_eq!(matches, [true, true, false]);
}

#[test]
fn reading_the_profile_leaves_the_electron_data_untouched() {
    let f = ElectronProfileFixture::install();
    let before = f.snapshot();
    let profile = located(&f);
    let scratch = Scratch::new(f.scratch_root()).unwrap();
    ProfileLock::probe(&profile).unwrap();
    let config = ElectronConfig::read(&profile).unwrap().unwrap();
    read_all_secrets(&profile, &f.key_source(), &NoKeytar).unwrap();
    LocalStorageSnapshot::read(&profile, "file://", &scratch)
        .unwrap()
        .unwrap();
    CustomDictionary::read(&profile).unwrap().unwrap();
    YStoreReader::open(&profile, &f.expected.vault_uuid, Some(&config), &scratch)
        .unwrap()
        .unwrap();
    YStoreReader::open_legacy(&profile, &scratch)
        .unwrap()
        .unwrap();
    assert!(open_data(&f.data_db()).is_err());
    assert_eq!(f.snapshot(), before);
}

#[test]
fn the_snapshot_sees_a_change_anywhere_in_the_electron_data() {
    for change in ["profile file", "profile dir", "data.db", "index.db"] {
        let f = ElectronProfileFixture::install();
        let before = f.snapshot();
        match change {
            "profile file" => fs::write(f.profile.join("Custom Dictionary.txt"), "x").unwrap(),
            "profile dir" => fs::create_dir(f.profile.join("new-empty-dir")).unwrap(),
            "data.db" => drop(Connection::open(f.data_db()).unwrap().execute(
                "INSERT INTO settings (key, value) VALUES ('touched', '1')",
                [],
            )),
            _ => fs::write(f.index_db(), b"").unwrap(),
        }
        assert_ne!(f.snapshot(), before, "{change}");
    }
}
