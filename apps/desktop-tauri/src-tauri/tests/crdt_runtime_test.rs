use memry_desktop_tauri_lib::crdt::CrdtRuntime;

#[tokio::test]
async fn runtime_starts_empty() {
    let runtime = CrdtRuntime::new();
    assert_eq!(runtime.open_doc_count().await, 0);
}

#[tokio::test]
async fn origin_tag_is_stable_across_calls() {
    let a = memry_desktop_tauri_lib::crdt::origin_tag();
    let b = memry_desktop_tauri_lib::crdt::origin_tag();
    assert_eq!(a, b);
    assert_ne!(a, 0);
}
