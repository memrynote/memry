use memry_desktop_tauri_lib::crdt::{apply_update_v1, DocStore};
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn apply_update_round_trip() {
    let source = DocStore::new();
    let target = DocStore::new();

    let s = source.get_or_init("note-1").await;
    s.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "hello world"));

    let snapshot = s.with_read(|txn| txn.encode_state_as_update_v1(&Default::default()));

    let t = target.get_or_init("note-1").await;
    apply_update_v1(&t, &snapshot, 42).expect("apply v1 update");

    let body = t.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, "hello world");
}

#[tokio::test]
async fn apply_invalid_bytes_returns_crdt_error() {
    let store = DocStore::new();
    let h = store.get_or_init("note-bogus").await;
    let err = apply_update_v1(&h, &[0xff, 0xff, 0xff], 1).unwrap_err();
    let msg = format!("{err:?}");
    assert!(msg.to_lowercase().contains("crdt"));
}
