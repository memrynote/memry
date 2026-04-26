use memry_desktop_tauri_lib::crdt::DocStore;
use yrs::{GetString, ReadTxn, Text, WriteTxn};

#[tokio::test]
async fn get_or_init_returns_same_doc_for_same_id() {
    let store = DocStore::new();
    let id = "note-alpha".to_string();

    let h1 = store.get_or_init(&id).await;
    let h2 = store.get_or_init(&id).await;

    h1.with_write(|txn| {
        let text = txn.get_or_insert_text("body");
        text.insert(txn, 0, "hello");
    });

    let snapshot = h2.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(snapshot, "hello");
    assert_eq!(store.open_count().await, 1);
}

#[tokio::test]
async fn drop_doc_removes_entry() {
    let store = DocStore::new();
    let id = "note-beta".to_string();
    let _h = store.get_or_init(&id).await;
    assert_eq!(store.open_count().await, 1);

    store.drop_doc(&id).await;
    assert_eq!(store.open_count().await, 0);
}

#[tokio::test]
async fn distinct_ids_get_distinct_docs() {
    let store = DocStore::new();
    let a = store.get_or_init("note-a").await;
    let b = store.get_or_init("note-b").await;
    a.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "A"));
    b.with_write(|txn| txn.get_or_insert_text("body").insert(txn, 0, "B"));

    let sa = a.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    let sb = b.with_read(|txn| txn.get_text("body").unwrap().get_string(txn));
    assert_eq!(sa, "A");
    assert_eq!(sb, "B");
}
