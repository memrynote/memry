use super::*;
use crate::electron_import::tests::{macos_fixture, synthetic};

#[test]
fn reads_stores_written_by_y_leveldb() {
    for slug in ["new", "legacy"] {
        let f = macos_fixture(slug);
        let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid)
            .unwrap()
            .unwrap();
        let mut names = store.doc_names();
        names.sort();
        let mut expected = f.expected.docs.clone();
        expected.sort();
        assert_eq!(names, expected);
        assert!(names.contains(&f.expected.unicode_id));
        assert_eq!(store.store_epoch(), Some("epoch-fixture-1"));
        assert!(YStoreReader::open_legacy(&f.profile).unwrap().is_some());
    }
}

#[test]
fn updates_are_ordered_by_clock_and_clocks_pass_255() {
    let f = macos_fixture("new");
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid)
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
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid)
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
    let store = YStoreReader::open(&f.profile, &f.expected.vault_uuid)
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
        YStoreReader::open(&f.profile, "11111111-1111-1111-1111-111111111111")
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_store_with_5000_updates() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 1, 5000);
    let store = YStoreReader::open_dir(dir.path()).unwrap().unwrap();
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
        YStoreReader::open_dir(dir.path()),
        Err(ImportError::Parse { .. })
    ));
}
