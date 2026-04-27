use memry_desktop_tauri_lib::crdt::wire::{CrdtUpdateEvent, CRDT_UPDATE_EVENT};

#[test]
fn event_name_matches_renderer_constant() {
    assert_eq!(CRDT_UPDATE_EVENT, "crdt-update");
}

#[test]
fn event_payload_serializes_with_origin() {
    let event = CrdtUpdateEvent {
        note_id: "n1".into(),
        update: vec![1, 2, 3],
        origin: 7,
    };
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"noteId\":\"n1\""));
    assert!(json.contains("\"origin\":7"));
}
