use memry_desktop_tauri_lib::commands::crdt::{crdt_close_doc_inner, crdt_open_doc_inner};
use memry_desktop_tauri_lib::crdt::CrdtRuntime;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use std::sync::Arc;

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
