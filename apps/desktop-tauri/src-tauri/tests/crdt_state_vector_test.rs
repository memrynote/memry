use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1, DocStore,
};
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn diff_since_state_vector_only_returns_new_ops() {
    let alpha = DocStore::new();
    let a = alpha.get_or_init("n").await;
    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "first "));

    let snapshot_at_sv = encode_snapshot_v1(&a).unwrap();
    let sv = encode_state_vector_v1(&a).unwrap();

    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 6, "second"));
    let diff = encode_diff_since_v1(&a, &sv).unwrap();

    let beta = DocStore::new();
    let b = beta.get_or_init("n").await;
    apply_update_v1(&b, &snapshot_at_sv, 1).unwrap();
    apply_update_v1(&b, &diff, 1).unwrap();

    let body = b.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, "first second");
}
