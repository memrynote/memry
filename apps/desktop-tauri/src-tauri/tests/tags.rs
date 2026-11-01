use std::sync::{Arc, Mutex};

use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::service::{Context, Sender};
use memry_tauri::commands::tags::{Written, announce};
use memry_tauri::events::{NoteTagsChangedEvent, TagCategoriesChangedEvent, TagColorUpdatedEvent};
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

#[test]
fn each_hub_write_sends_electrons_events_and_a_new_category_its_telemetry() {
    let dir = tempfile::tempdir().expect("tmp");
    let app = mock_app();
    let service = telemetry(dir.path());
    app.manage(service.clone());
    let heard = Arc::new(Mutex::new(Vec::<(&str, String)>::new()));
    for name in [
        TagColorUpdatedEvent::NAME,
        NoteTagsChangedEvent::NAME,
        TagCategoriesChangedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            sink.lock()
                .expect("lock")
                .push((name, event.payload().to_owned()));
        });
    }
    let sent = |written| {
        announce(app.handle(), written);
        std::mem::take(&mut *heard.lock().expect("lock"))
    };
    let color = |payload: &str| (TagColorUpdatedEvent::NAME, payload.to_owned());
    let tags = (NoteTagsChangedEvent::NAME, "null".to_owned());
    let categories = |payload: &str| (TagCategoriesChangedEvent::NAME, payload.to_owned());

    let written = Written::Color {
        tag: "Work".into(),
        color: "teal".into(),
    };
    assert_eq!(
        sent(written),
        [color(r#"{"tag":"Work","color":"teal"}"#), tags.clone()]
    );
    assert_eq!(sent(Written::Icon), [tags]);
    assert!(service.queued().is_empty());
    assert_eq!(
        sent(Written::CategoryCreated("cat-1".into())),
        [categories(r#"{"categoryId":"cat-1"}"#)]
    );
    let queued = service.queued();
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(queued[0].name, "tag_category_created");
    assert_eq!(queued[0].object_type.as_deref(), Some("tag_category"));
    assert_eq!(
        sent(Written::Category("cat-1".into())),
        [categories(r#"{"categoryId":"cat-1"}"#)]
    );
    assert_eq!(sent(Written::Drag), [categories(r#"{"categoryId":null}"#)]);
    assert_eq!(
        service.queued().len(),
        1,
        "only a created category is tracked"
    );
}
