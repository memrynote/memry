use std::sync::{Arc, Mutex};

use memry_desktop::journal::JournalEntryView;
use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::service::{Context, Sender};
use memry_tauri::commands::journal::{Landed, announce};
use memry_tauri::events::{JournalEntryCreatedEvent, JournalEntryDeletedEvent};
use serde_json::{Value, json};
use tauri::test::mock_app;
use tauri::{Listener, Manager};
use tauri_specta::Event;

/// A telemetry service that queues and never sends.
fn telemetry(dir: &std::path::Path) -> Arc<Service> {
    let context = Context {
        install_id: "i".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "linux".into(),
        arch: "x64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    let sender = Sender::new("http://127.0.0.1:1/x", NativeTransport::loopback());
    Arc::new(Service::start(dir, context, sender, true))
}

fn day() -> JournalEntryView {
    JournalEntryView {
        id: "j2025-01-17".into(),
        date: "2025-01-17".into(),
        content: "Morning pages.".into(),
        word_count: 2,
        character_count: 14,
        tags: vec!["work".into()],
        aliases: vec![],
        properties: json!({ "mood": "calm" }).as_object().cloned(),
        created_at: "2025-01-17T08:00:00.000Z".into(),
        modified_at: "2025-01-17T09:00:00.000Z".into(),
    }
}

#[test]
fn each_journal_command_sends_electrons_events_and_a_found_read_its_telemetry() {
    let dir = tempfile::tempdir().expect("tmp");
    let app = mock_app();
    let service = telemetry(dir.path());
    app.manage(service.clone());
    let heard = Arc::new(Mutex::new(Vec::<(&str, Value)>::new()));
    for name in [
        JournalEntryCreatedEvent::NAME,
        JournalEntryDeletedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            let payload = serde_json::from_str(event.payload()).expect("json");
            sink.lock().expect("lock").push((name, payload));
        });
    }
    let entry = day();
    let sent = |landed| {
        announce(app.handle(), landed);
        std::mem::take(&mut *heard.lock().expect("lock"))
    };

    assert_eq!(sent(Landed::Read { found: false }), []);
    assert!(
        service.queued().is_empty(),
        "a day with no entry is not opened"
    );
    assert_eq!(sent(Landed::Read { found: true }), []);
    let queued = service.queued();
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(queued[0].name, "journal_opened");
    assert_eq!(queued[0].object_type.as_deref(), Some("journal"));
    assert_eq!(queued[0].result.as_deref(), Some("success"));

    let created = json!({
        "date": "2025-01-17",
        "entry": {
            "id": "j2025-01-17",
            "date": "2025-01-17",
            "content": "Morning pages.",
            "wordCount": 2,
            "characterCount": 14,
            "tags": ["work"],
            "aliases": [],
            "properties": { "mood": "calm" },
            "createdAt": "2025-01-17T08:00:00.000Z",
            "modifiedAt": "2025-01-17T09:00:00.000Z"
        }
    });
    assert_eq!(
        sent(Landed::Created(&entry)),
        [(JournalEntryCreatedEvent::NAME, created)]
    );

    let deleted = |success| Landed::Deleted {
        date: "2025-01-17".into(),
        success,
    };
    assert_eq!(sent(deleted(false)), [], "nothing was deleted");
    assert_eq!(
        sent(deleted(true)),
        [(
            JournalEntryDeletedEvent::NAME,
            json!({ "date": "2025-01-17" })
        )]
    );
    assert_eq!(service.queued().len(), 1, "only a found read is tracked");
}
