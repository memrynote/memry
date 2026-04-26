use memry_desktop_tauri_lib::error::AppError;

#[test]
fn crdt_variant_serializes() {
    let err = AppError::Crdt("bad update bytes".to_string());
    let json = serde_json::to_string(&err).unwrap();
    assert!(json.contains("\"kind\":\"Crdt\""));
    assert!(json.contains("\"message\":\"bad update bytes\""));
}

#[test]
fn crdt_display_message() {
    let err = AppError::Crdt("bad update bytes".to_string());
    assert_eq!(err.to_string(), "crdt error: bad update bytes");
}
