use memry_desktop_tauri_lib::commands::crdt::{
    crdt_apply_update_chunk_append_inner, crdt_apply_update_chunk_finish_inner,
    crdt_apply_update_chunk_start_inner, crdt_apply_update_inner, crdt_close_doc_inner,
    crdt_get_snapshot_bytes, crdt_get_state_vector_bytes, crdt_open_doc_inner,
    crdt_sync_step_1_inner, crdt_sync_step_2_inner, MAX_INLINE_UPDATE_BYTES,
};
use memry_desktop_tauri_lib::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1,
    CrdtRuntime,
};
use memry_desktop_tauri_lib::db::crdt_updates;
use memry_desktop_tauri_lib::error::AppError;
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

#[tokio::test]
async fn oversized_update_uses_chunked_transport_and_persists_once() {
    let conn = open_in_memory_with_migrations();
    let crdt = Arc::new(CrdtRuntime::new());
    let source = Arc::new(CrdtRuntime::new());
    let source_doc = source.docs().get_or_init("large").await;
    let body = "x".repeat(MAX_INLINE_UPDATE_BYTES + 12_000);
    source_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 0, &body);
    });
    let update = encode_snapshot_v1(&source_doc).unwrap();
    assert!(update.len() > MAX_INLINE_UPDATE_BYTES);

    let err = crdt_apply_update_inner(&conn, crdt.clone(), "large", &update, 303)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(message) if message.contains("chunked")));

    crdt_apply_update_chunk_start_inner(
        crdt.clone(),
        "large",
        "transfer-1",
        update.len(),
    )
    .await
    .unwrap();
    for (offset, chunk) in update.chunks(4096).enumerate() {
        crdt_apply_update_chunk_append_inner(
            crdt.clone(),
            "transfer-1",
            offset * 4096,
            chunk.to_vec(),
        )
        .await
        .unwrap();
    }
    let seq = crdt_apply_update_chunk_finish_inner(
        &conn,
        crdt.clone(),
        "large",
        "transfer-1",
        303,
    )
    .await
    .unwrap();

    assert_eq!(seq, 1);
    let rows = crdt_updates::list_for_note(&conn, "large").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].origin, 303);
    assert_eq!(rows[0].update_bytes, update);

    let target_doc = crdt.docs().get("large").await.unwrap();
    let target_body = target_doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(target_body, body);
}

#[tokio::test]
async fn snapshot_and_state_vector_bytes_round_trip() {
    let conn = open_in_memory_with_migrations();
    let crdt = Arc::new(CrdtRuntime::new());
    let source = Arc::new(CrdtRuntime::new());
    let source_doc = source.docs().get_or_init("snap").await;
    source_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 0, "snapshot body");
    });
    let update = encode_snapshot_v1(&source_doc).unwrap();
    crdt_apply_update_inner(&conn, crdt.clone(), "snap", &update, 404)
        .await
        .unwrap();

    let snapshot = crdt_get_snapshot_bytes(crdt.clone(), "snap").await.unwrap();
    let state_vector = crdt_get_state_vector_bytes(crdt.clone(), "snap")
        .await
        .unwrap();

    assert!(!snapshot.is_empty());
    assert!(!state_vector.is_empty());
    let restored = Arc::new(CrdtRuntime::new());
    let restored_doc = restored.docs().get_or_init("snap").await;
    apply_update_v1(&restored_doc, &snapshot, 1).unwrap();
    let restored_body = restored_doc.with_read(|txn| {
        txn.get_text("body")
            .map(|text| text.get_string(txn))
            .unwrap_or_default()
    });
    assert_eq!(restored_body, "snapshot body");
}

#[tokio::test]
async fn sync_steps_exchange_diffs_from_state_vectors() {
    let conn = open_in_memory_with_migrations();
    let rust = Arc::new(CrdtRuntime::new());
    let source = Arc::new(CrdtRuntime::new());
    let source_doc = source.docs().get_or_init("sync").await;
    source_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 0, "server");
    });
    let server_update = encode_snapshot_v1(&source_doc).unwrap();
    crdt_apply_update_inner(&conn, rust.clone(), "sync", &server_update, 505)
        .await
        .unwrap();

    let renderer = Arc::new(CrdtRuntime::new());
    let renderer_doc = renderer.docs().get_or_init("sync").await;
    let renderer_sv = encode_state_vector_v1(&renderer_doc).unwrap();
    let step_1 = crdt_sync_step_1_inner(rust.clone(), "sync", &renderer_sv)
        .await
        .unwrap();
    apply_update_v1(&renderer_doc, &step_1.diff, 1).unwrap();
    let renderer_body = renderer_doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(renderer_body, "server");

    renderer_doc.with_write(|txn| {
        txn.get_or_insert_text("body").insert(txn, 6, " client");
    });
    let renderer_diff = encode_diff_since_v1(&renderer_doc, &step_1.state_vector).unwrap();
    crdt_sync_step_2_inner(&conn, rust.clone(), "sync", &renderer_diff)
        .await
        .unwrap();

    let rust_doc = rust.docs().get("sync").await.unwrap();
    let rust_body = rust_doc.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(rust_body, "server client");
}
