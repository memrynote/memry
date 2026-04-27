use memry_desktop_tauri_lib::crdt::{apply_update_v1, encode_snapshot_v1, DocStore};
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn snapshot_round_trips_through_fresh_doc() {
    let original = DocStore::new();
    let h = original.get_or_init("note").await;
    h.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "abc"));

    let snapshot = encode_snapshot_v1(&h).expect("encode");

    let restored = DocStore::new();
    let r = restored.get_or_init("note").await;
    apply_update_v1(&r, &snapshot, 1).unwrap();

    let body = r.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, "abc");
}

#[tokio::test]
async fn empty_doc_snapshot_is_minimal_but_valid() {
    let store = DocStore::new();
    let h = store.get_or_init("empty").await;
    let snapshot = encode_snapshot_v1(&h).expect("encode");
    assert!(!snapshot.is_empty());

    let other = DocStore::new();
    let o = other.get_or_init("empty").await;
    apply_update_v1(&o, &snapshot, 1).unwrap();
    let body = o.with_read(|txn| {
        txn.get_text("body")
            .map(|text| text.get_string(txn))
            .unwrap_or_default()
    });
    assert_eq!(body, "");
}
