use super::*;
use crate::electron_import::config::ElectronConfig;
use crate::electron_import::tests::{macos_fixture, synthetic};

#[test]
fn reads_stores_written_by_y_leveldb() {
    for slug in ["new", "legacy"] {
        let f = macos_fixture(slug);
        let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
            .unwrap()
            .unwrap();
        let mut names = store.doc_names();
        names.sort();
        let mut expected = f.expected.docs.clone();
        expected.sort();
        assert_eq!(names, expected);
        assert!(names.contains(&f.expected.unicode_id));
        assert_eq!(store.store_epoch(), Some("epoch-fixture-1"));
        assert!(
            YStoreReader::open_legacy(&f.profile, &f.scratch)
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn updates_are_ordered_by_clock_and_clocks_pass_255() {
    let f = macos_fixture("new");
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
        .unwrap()
        .unwrap();
    let updates = store.updates(&f.expected.note_id);
    assert_eq!(updates.len(), 300);
    assert!(updates.windows(2).all(|w| w[0].0 < w[1].0));
    assert!(updates.last().unwrap().0 > 255);
    assert!(updates.iter().all(|(_, bytes)| !bytes.is_empty()));
    assert!(store.updates("absent").is_empty());
}

#[test]
fn state_vector_and_meta() {
    let f = macos_fixture("new");
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
        .unwrap()
        .unwrap();
    assert!(store.state_vector(&f.expected.flushed_id).is_some());
    assert_eq!(
        store.meta(&f.expected.note_id, "adapter-snapshot-up-to-seq"),
        Some(&Lib0Any::Integer(17))
    );
    assert_eq!(store.meta(&f.expected.note_id, "absent"), None);
}

#[test]
fn watermark() {
    let f = macos_fixture("new");
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
        .unwrap()
        .unwrap();
    assert_eq!(
        store.watermark(&f.expected.note_id),
        Some(SnapshotWatermark {
            applied_sequence: 42,
            snapshot_revision: Some("rev-7".into())
        })
    );
    // Malformed record (`appliedSequence` is a string) and a document with no record.
    assert_eq!(store.watermark(&f.expected.journal_id), None);
    assert_eq!(store.watermark(&f.expected.unicode_id), None);
    assert_eq!(store.watermark("absent"), None);
}

#[test]
fn watermark_validation_follows_decode_snapshot_watermark() {
    let mk = |fields: Vec<(&str, Lib0Any)>| {
        let mut doc = DocData::default();
        let object = fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        doc.meta
            .insert(SNAPSHOT_WATERMARK_KEY.into(), Lib0Any::Object(object));
        YStoreReader {
            ignored_keys: 0,
            torn_tails: Vec::new(),
            docs: [("d".to_owned(), doc)].into(),
        }
    };
    let seq = |n| ("appliedSequence", Lib0Any::Integer(n));
    assert_eq!(
        mk(vec![seq(0)]).watermark("d").unwrap().snapshot_revision,
        None
    );
    assert!(mk(vec![seq(-1)]).watermark("d").is_none());
    assert!(
        mk(vec![("appliedSequence", Lib0Any::Float(1.5))])
            .watermark("d")
            .is_none()
    );
    assert_eq!(
        mk(vec![("appliedSequence", Lib0Any::Float(3_000_000_000.0))])
            .watermark("d")
            .unwrap()
            .applied_sequence,
        3_000_000_000
    );
    assert!(
        mk(vec![seq(1), ("snapshotRevision", Lib0Any::Integer(3))])
            .watermark("d")
            .is_none()
    );
    assert!(mk(vec![]).watermark("d").is_none());
}

#[test]
fn absent_store_is_none() {
    let f = macos_fixture("new");
    assert!(
        YStoreReader::open(
            &f.profile,
            "11111111-1111-1111-1111-111111111111",
            None,
            &f.scratch
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn a_store_with_5000_updates() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 1, 5000);
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let store = YStoreReader::open_dir(dir.path(), &scratch)
        .unwrap()
        .unwrap();
    let updates = store.updates("doc-00000");
    assert_eq!(updates.len(), 5000);
    assert_eq!(updates[4999].0, 4999);
    assert_eq!(updates[300].1, &[44_u8; 64][..]);
}

#[test]
fn an_undecodable_key_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    let mut db = rusty_leveldb::DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
    db.put(&[9, 9, 9], b"x").unwrap();
    db.flush().unwrap();
    drop(db);
    assert!(matches!(
        YStoreReader::open_dir(dir.path(), &crate::electron_import::tests::test_scratch().1),
        Err(ImportError::Parse { .. })
    ));
}

fn config_with_pending(old: &str, new: &str) -> ElectronConfig {
    ElectronConfig::parse(
        serde_json::json!({"crdtStore": {"pendingRenames": {new: old}}})
            .to_string()
            .as_bytes(),
    )
    .unwrap()
}

#[test]
fn a_pending_rename_finds_the_store_still_named_after_the_old_uuid() {
    let f = macos_fixture("new");
    let new_uuid = "22222222-2222-2222-2222-222222222222";
    let old = f.profile.crdt_store_root().join(&f.expected.vault_uuid);
    // The Electron app has not renamed the directory yet: the vault now has `new_uuid`.
    let config = config_with_pending(&f.expected.vault_uuid, new_uuid);
    assert!(
        YStoreReader::open(&f.profile, new_uuid, None, &f.scratch)
            .unwrap()
            .is_none()
    );
    let store = YStoreReader::open(&f.profile, new_uuid, Some(&config), &f.scratch)
        .unwrap()
        .unwrap();
    assert_eq!(store.updates(&f.expected.note_id).len(), 300);
    assert_eq!(
        YStoreReader::store_dir(&f.profile, new_uuid, Some(&config)),
        old
    );
}

#[test]
fn a_pending_rename_never_overrides_an_existing_store_of_the_new_name() {
    let f = macos_fixture("new");
    let new_uuid = "22222222-2222-2222-2222-222222222222";
    let own = f.profile.crdt_store_root().join(new_uuid);
    std::fs::create_dir_all(&own).unwrap();
    let config = config_with_pending(&f.expected.vault_uuid, new_uuid);
    assert_eq!(
        YStoreReader::store_dir(&f.profile, new_uuid, Some(&config)),
        own
    );
    // The old directory still holds history nobody reads: that is reportable, not silent.
    assert_eq!(
        YStoreReader::unread_previous_store(&f.profile, new_uuid, Some(&config)),
        Some(f.profile.crdt_store_root().join(&f.expected.vault_uuid))
    );
    assert_eq!(
        YStoreReader::unread_previous_store(&f.profile, &f.expected.vault_uuid, Some(&config)),
        None
    );
    // A rename whose old directory is gone also reads as the vault's own (absent) store.
    let none = config_with_pending(
        "33333333-3333-3333-3333-333333333333",
        "44444444-4444-4444-4444-444444444444",
    );
    assert_eq!(
        YStoreReader::store_dir(
            &f.profile,
            "44444444-4444-4444-4444-444444444444",
            Some(&none)
        ),
        f.profile
            .crdt_store_root()
            .join("44444444-4444-4444-4444-444444444444")
    );
}

#[test]
fn unknown_keys_are_counted_not_dropped_silently() {
    let f = macos_fixture("new");
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
        .unwrap()
        .unwrap();
    assert_eq!(store.ignored_keys(), 0);
    let dir = tempfile::tempdir().unwrap();
    let mut db = rusty_leveldb::DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
    for key in [
        synthetic::update_key("d", 1),
        synthetic::string_keys(&["v2", "d"]),
        synthetic::string_keys(&["v1", "d", "other", "x"]),
    ] {
        db.put(&key, b"x").unwrap();
    }
    db.flush().unwrap();
    drop(db);
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let store = YStoreReader::open_dir(dir.path(), &scratch)
        .unwrap()
        .unwrap();
    assert_eq!(store.ignored_keys(), 2);
    assert_eq!(store.updates("d").len(), 1);
}
