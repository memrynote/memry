use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, compact_doc, CompactionResult, DocStore, COMPACT_THRESHOLD,
};
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn compact_returns_snapshot_and_drop_seq() {
    let store = DocStore::new();
    let h = store.get_or_init("note").await;

    for i in 0..=COMPACT_THRESHOLD {
        h.with_write(|txn| {
            txn.get_or_insert_text("body")
                .insert(txn, 0, &i.to_string());
        });
    }

    let result: CompactionResult = compact_doc(&h, COMPACT_THRESHOLD + 1).expect("compact");
    assert_eq!(result.replaced_through_seq, COMPACT_THRESHOLD + 1);
    assert!(!result.snapshot_bytes.is_empty());

    let restored = DocStore::new();
    let r = restored.get_or_init("note").await;
    apply_update_v1(&r, &result.snapshot_bytes, 1).unwrap();
    let body = r.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    let original_body = h.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, original_body);
}
