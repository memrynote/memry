use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1, DocStore,
};
use memry_desktop_tauri_lib::db::crdt_snapshots::{get_latest, upsert_with_compaction};
use memry_desktop_tauri_lib::db::crdt_updates::{append, list_for_note};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[test]
fn get_latest_returns_none_then_latest_snapshot() {
    let conn = open_in_memory_with_migrations();

    assert!(get_latest(&conn, "missing").unwrap().is_none());

    upsert_with_compaction(&conn, "n", &[1, 2, 3], &[4, 5], 0).unwrap();
    let first = get_latest(&conn, "n").unwrap().unwrap();
    assert_eq!(first.note_id, "n");
    assert_eq!(first.snapshot_bytes, vec![1, 2, 3]);
    assert_eq!(first.state_vector, vec![4, 5]);
    assert_eq!(first.replaced_through_seq, 0);
    assert!(!first.created_at.is_empty());

    upsert_with_compaction(&conn, "n", &[9], &[8, 7], 4).unwrap();
    let second = get_latest(&conn, "n").unwrap().unwrap();
    assert_eq!(second.snapshot_bytes, vec![9]);
    assert_eq!(second.state_vector, vec![8, 7]);
    assert_eq!(second.replaced_through_seq, 4);
}

#[test]
fn upsert_with_compaction_rolls_back_snapshot_when_drop_fails() {
    let conn = open_in_memory_with_migrations();
    append(&conn, "n", &[1], 1).unwrap();
    append(&conn, "n", &[2], 1).unwrap();

    conn.execute_batch(
        "CREATE TEMP TRIGGER fail_crdt_update_delete
         BEFORE DELETE ON crdt_updates
         BEGIN
             SELECT RAISE(FAIL, 'forced delete failure');
         END;",
    )
    .unwrap();

    let err = upsert_with_compaction(&conn, "n", &[9], &[8], 2).unwrap_err();
    let msg = format!("{err:?}");

    assert!(msg.contains("forced delete failure"));
    assert!(get_latest(&conn, "n").unwrap().is_none());
    assert_eq!(list_for_note(&conn, "n").unwrap().len(), 2);
}

#[tokio::test]
async fn compaction_snapshot_and_remaining_updates_replay_to_same_doc() {
    let conn = open_in_memory_with_migrations();
    let original = DocStore::new();
    let doc = original.get_or_init("n").await;
    doc.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "first "));

    let snapshot = encode_snapshot_v1(&doc).unwrap();
    let state_vector = encode_state_vector_v1(&doc).unwrap();
    append(&conn, "n", &snapshot, 7).unwrap();

    doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 6, "second");
    });
    let diff = encode_diff_since_v1(&doc, &state_vector).unwrap();
    append(&conn, "n", &diff, 9).unwrap();

    upsert_with_compaction(&conn, "n", &snapshot, &state_vector, 1).unwrap();

    let persisted = get_latest(&conn, "n").unwrap().unwrap();
    let remaining = list_for_note(&conn, "n").unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].seq, 2);

    let restored = DocStore::new();
    let restored_doc = restored.get_or_init("n").await;
    apply_update_v1(&restored_doc, &persisted.snapshot_bytes, 1).unwrap();
    for row in remaining {
        apply_update_v1(&restored_doc, &row.update_bytes, row.origin as u32).unwrap();
    }

    let body = restored_doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    let original_body = doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, original_body);
}
