use memry_desktop_tauri_lib::commands::crdt::{
    crdt_apply_update_inner, crdt_close_doc_inner, crdt_open_doc_inner,
};
use memry_desktop_tauri_lib::crdt::{
    encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1, CrdtRuntime,
};
use memry_desktop_tauri_lib::db::crdt_updates;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use std::sync::Arc;
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn open_doc_creates_runtime_entry() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = Arc::new(CrdtRuntime::new());

    crdt_open_doc_inner(&conn, &vault, crdt.clone(), "n1")
        .await
        .unwrap();

    assert_eq!(crdt.open_doc_count().await, 1);
}

#[tokio::test]
async fn close_doc_drops_runtime_entry() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let crdt = Arc::new(CrdtRuntime::new());

    crdt_open_doc_inner(&conn, &vault, crdt.clone(), "n1")
        .await
        .unwrap();
    crdt_close_doc_inner(crdt.clone(), "n1").await;

    assert_eq!(crdt.open_doc_count().await, 0);
}

#[tokio::test]
async fn apply_update_persists_seq_order_origin_and_doc_state() {
    let conn = open_in_memory_with_migrations();
    let crdt = Arc::new(CrdtRuntime::new());
    let source = Arc::new(CrdtRuntime::new());
    let source_doc = source.docs().get_or_init("n1").await;

    source_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 0, "alpha");
    });
    let update_a = encode_snapshot_v1(&source_doc).unwrap();
    let sv_after_a = encode_state_vector_v1(&source_doc).unwrap();
    source_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 5, " beta");
    });
    let update_b = encode_diff_since_v1(&source_doc, &sv_after_a).unwrap();

    let seq_a = crdt_apply_update_inner(&conn, crdt.clone(), "n1", &update_a, 101)
        .await
        .unwrap();
    let seq_b = crdt_apply_update_inner(&conn, crdt.clone(), "n1", &update_b, 202)
        .await
        .unwrap();

    assert_eq!((seq_a, seq_b), (1, 2));
    let rows = crdt_updates::list_for_note(&conn, "n1").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].seq, 1);
    assert_eq!(rows[0].origin, 101);
    assert_eq!(rows[1].seq, 2);
    assert_eq!(rows[1].origin, 202);

    let target_doc = crdt.docs().get("n1").await.unwrap();
    let body = target_doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(body, "alpha beta");
}
