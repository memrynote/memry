//! The native calendar commands (#3546 29b) through the IPC a renderer calls, on a mock app
//! over a real vault and `Session`: the argument names the generated bindings send, the
//! contract's field names in the answers (`calendar-api.ts`), one `CalendarChangedEvent` per
//! create, update and delete, the handlers' telemetry, and the `success: false` answers.

#[allow(dead_code, reason = "the tests reach the vault through the session")]
mod support;

use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound;
use memry_desktop::calendar::service::CalendarService;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::settings::SettingsService;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::service::{Context, Sender};
use memry_tauri::events::CalendarChangedEvent;
use serde_json::{Value, json};
use support::{MemoryStore, Mocked};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::{ErrorHandlingMode, Event, collect_commands};

struct Calendar {
    mocked: Mocked,
    heard: Arc<Mutex<Vec<Value>>>,
    telemetry: Arc<Service>,
    _dir: tempfile::TempDir,
}

impl Calendar {
    fn call(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.mocked.invoke(cmd, args)
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.call(cmd, args)
            .unwrap_or_else(|error| panic!("{cmd} threw {error}"))
    }

    fn heard(&self) -> Vec<Value> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }

    fn tracked(&self) -> Vec<(String, Value)> {
        self.telemetry
            .queued()
            .into_iter()
            .map(|e| (e.name, serde_json::to_value(e.metrics).unwrap()))
            .collect()
    }

    /// Applies synced calendar records to the open vault, as a pull would.
    fn apply(&self, records: &[(&str, &str, Value)]) {
        let records: Vec<InboundRecord> = records
            .iter()
            .map(|(item_type, id, payload)| InboundRecord {
                item_type: (*item_type).to_owned(),
                item_id: (*id).to_owned(),
                payload_json: payload.to_string(),
                server_cursor: None,
                signer_device_id: None,
                updated_at: 0,
                deleted_at: None,
            })
            .collect();
        let open = self.mocked.session().current().unwrap();
        open.vault
            .db_handle()
            .call_blocking(move |conn| {
                for record in &records {
                    apply_inbound(conn, record, 1)?;
                }
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }
}

fn opened(files: &[(&str, &str)]) -> Calendar {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::calendar::calendar_create_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_delete_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_get_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_get_external_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_get_range::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_list_linked_notes::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_list_sources::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_promote_external_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_search_events::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_update_event::<MockRuntime>,
            memry_tauri::commands::calendar::calendar_update_source_selection::<MockRuntime>,
        ]);
    let mocked = Mocked::open(files, commands);
    let dir = tempfile::tempdir().unwrap();
    // The device key `Mocked` opened the vault under.
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let app = mocked.webview.app_handle().clone();
    app.manage(Arc::new(CalendarService::new(
        store.clone(),
        SettingsService::new(store, config),
    )));
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
    let telemetry = Arc::new(Service::start(dir.path(), context, sender, true));
    app.manage(telemetry.clone());
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    app.listen_any(CalendarChangedEvent::NAME, move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    Calendar {
        mocked,
        heard,
        telemetry,
        _dir: dir,
    }
}

fn changed(id: &Value) -> Vec<Value> {
    vec![json!({ "entityType": "calendar_event", "id": id })]
}

#[test]
fn an_event_round_trips_through_create_read_update_and_delete() {
    let cal = opened(&[]);
    let created = cal.ok(
        "calendar_create_event",
        json!({ "input": {
            "title": "Design review", "startAt": "2026-09-29T09:00:00.000Z",
            "endAt": "2026-09-29T10:00:00.000Z", "timezone": "Europe/Istanbul",
            "description": "Agenda", "color": "tomato"
        }}),
    );
    assert_eq!(created["success"], true);
    assert!(created.get("error").is_none());
    let event = &created["event"];
    let id = event["id"].clone();
    assert_eq!(event["title"], "Design review");
    assert_eq!(event["color"], "tomato");
    assert_eq!(event["isAllDay"], false);
    assert_eq!(event["recurrenceRule"], Value::Null);
    assert!(event["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(cal.heard(), changed(&id));

    assert_eq!(
        cal.ok("calendar_get_event", json!({ "id": id }))["title"],
        "Design review"
    );
    assert_eq!(
        cal.ok("calendar_get_event", json!({ "id": "missing" })),
        Value::Null
    );

    let updated = cal.ok(
        "calendar_update_event",
        json!({ "input": { "id": id, "title": "Design sync", "description": null, "color": "tomato" }}),
    );
    assert_eq!(updated["success"], true);
    assert_eq!(updated["event"]["title"], "Design sync");
    assert_eq!(updated["event"]["description"], Value::Null);
    assert_eq!(updated["event"]["location"], Value::Null);
    assert_eq!(cal.heard(), changed(&id));

    let range = cal.ok(
        "calendar_get_range",
        json!({ "input": { "startAt": "2026-09-01T00:00:00.000Z", "endAt": "2026-10-01T00:00:00.000Z" }}),
    );
    let items = range["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["projectionId"],
        json!(format!("event:{}", id.as_str().unwrap()))
    );
    assert_eq!(items[0]["sourceType"], "event");
    assert_eq!(items[0]["editability"]["canResize"], true);
    assert_eq!(items[0]["source"]["isMemryManaged"], true);
    assert!(items[0].get("task").is_none());

    let found = cal.ok(
        "calendar_search_events",
        json!({ "input": { "query": "design" }}),
    );
    assert_eq!(found["events"][0]["id"], id);
    assert!(found["events"][0].get("kind").is_none());

    assert_eq!(
        cal.ok("calendar_delete_event", json!({ "id": id })),
        json!({ "success": true })
    );
    assert_eq!(cal.heard(), changed(&id));
    let again = cal.ok("calendar_delete_event", json!({ "id": id }));
    assert_eq!(again["success"], false);
    assert!(!again["error"].as_str().unwrap().is_empty());
    let gone = cal.ok(
        "calendar_update_event",
        json!({ "input": { "id": id, "title": "x" }}),
    );
    assert_eq!(gone["success"], false);
    assert_eq!(gone["event"], Value::Null);
    assert!(cal.heard().is_empty(), "a refused change sends no event");

    let tracked = cal.tracked();
    let names: Vec<&str> = tracked.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "calendar_event_created",
            "calendar_event_updated",
            "calendar_event_deleted"
        ]
    );
    // title and description; the colour it already had is no change.
    assert_eq!(tracked[1].1, json!({ "itemCount": 2.0 }));
}

#[test]
fn input_the_contract_refuses_throws() {
    let cal = opened(&[]);
    for (cmd, args) in [
        (
            "calendar_create_event",
            json!({ "input": { "title": "", "startAt": "2026-09-29T09:00:00.000Z" }}),
        ),
        (
            "calendar_create_event",
            json!({ "input": { "title": "x", "startAt": "tomorrow" }}),
        ),
        (
            "calendar_get_range",
            json!({ "input": { "startAt": "x", "endAt": "2026-10-01T00:00:00.000Z" }}),
        ),
        (
            "calendar_search_events",
            json!({ "input": { "query": "a", "limit": 101 }}),
        ),
    ] {
        let error = cal.call(cmd, args).expect_err(cmd);
        assert_eq!(error["kind"], "invalid", "{cmd}: {error}");
    }
    assert!(cal.heard().is_empty());
}

const SOURCE: &str = "src-work";

fn google_records() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "calendar_source",
            SOURCE,
            json!({
                "id": SOURCE, "provider": "google", "kind": "calendar", "accountId": "acct-1",
                "remoteId": "work@group.calendar.google.com", "title": "Work",
                "isSelected": true, "isPrimary": false, "isMemryManaged": false,
                "clock": { "desktop": 1 },
                "metadata": { "sourceTitle": "kaan@example.com" },
                "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
            }),
        ),
        (
            "calendar_external_event",
            "ext-1",
            json!({
                "id": "ext-1", "sourceId": SOURCE, "remoteEventId": "g-1",
                "title": "Planning", "startAt": "2026-09-24T07:00:00.000Z",
                "endAt": "2026-09-24T08:30:00.000Z", "isAllDay": false, "status": "confirmed",
                "clock": { "desktop": 2 },
                "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
            }),
        ),
    ]
}

#[test]
fn an_imported_event_reads_promotes_and_keeps_its_linked_notes() {
    let cal = opened(&[("Meeting notes.md", "# Meeting notes\n")]);
    cal.apply(&google_records());

    let details = cal.ok(
        "calendar_get_external_event",
        json!({ "input": { "externalEventId": "ext-1" }}),
    );
    assert_eq!(details["event"]["title"], "Planning");
    assert_eq!(
        details["event"]["source"],
        json!({ "id": SOURCE, "provider": "google", "title": "Work", "color": null,
                "accountTitle": "kaan@example.com" })
    );
    let missing = cal.ok(
        "calendar_get_external_event",
        json!({ "input": { "externalEventId": "nope" }}),
    );
    assert_eq!(missing, json!({ "event": null }));

    // A note links the mirror before promotion.
    let open = cal.mocked.session().current().unwrap();
    let note_id: String = open
        .vault
        .db_handle()
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT id FROM notes WHERE title = 'Meeting notes'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .unwrap();
    // `encodeExternalEventRelationId("ext-1")`: base64url without padding.
    let target = "ZXh0LTE".to_owned();
    let source = note_id.clone();
    open.search
        .index_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "INSERT INTO property_refs (source_id, name, target_type, target_id)
                 VALUES (?1, 'meeting', 'external-event', ?2)",
                [&source, &target],
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .unwrap();
    let linked = |source_type: &str, id: &Value| {
        cal.ok(
            "calendar_list_linked_notes",
            json!({ "input": { "sourceType": source_type, "sourceId": id }}),
        )["notes"]
            .clone()
    };
    let expected = json!([{ "id": note_id, "title": "Meeting notes", "emoji": null }]);
    assert_eq!(linked("external_event", &json!("ext-1")), expected);

    let promoted = cal.ok(
        "calendar_promote_external_event",
        json!({ "input": { "externalEventId": "ext-1" }}),
    );
    assert_eq!(promoted["success"], true);
    let event_id = promoted["eventId"].clone();
    assert_eq!(
        linked("event", &event_id),
        expected,
        "the promoted copy keeps the mirror's links"
    );
    let refused = cal.ok(
        "calendar_promote_external_event",
        json!({ "input": { "externalEventId": "nope" }}),
    );
    assert_eq!(refused["success"], false);
    assert_eq!(refused["eventId"], Value::Null);
    assert!(
        cal.heard().is_empty(),
        "a promote sends no event, as Electron's did"
    );
    assert_eq!(
        cal.ok("calendar_get_event", json!({ "id": event_id }))["title"],
        "Planning"
    );
}

#[test]
fn sources_list_filter_and_change_selection() {
    let cal = opened(&[]);
    cal.apply(&google_records());

    let all = cal.ok("calendar_list_sources", json!({ "input": null }));
    let source = &all["sources"][0];
    assert_eq!(source["id"], SOURCE);
    assert_eq!(source["kind"], "calendar");
    assert_eq!(source["isSelected"], true);
    assert_eq!(
        source["metadata"],
        json!({ "sourceTitle": "kaan@example.com" })
    );
    let none = cal.ok(
        "calendar_list_sources",
        json!({ "input": { "provider": "ics" }}),
    );
    assert_eq!(none, json!({ "sources": [] }));

    let hidden = cal.ok(
        "calendar_update_source_selection",
        json!({ "input": { "id": SOURCE, "isSelected": false }}),
    );
    assert_eq!(hidden["success"], true);
    assert_eq!(hidden["source"]["isSelected"], false);
    let selected = cal.ok(
        "calendar_list_sources",
        json!({ "input": { "selectedOnly": true }}),
    );
    assert_eq!(selected, json!({ "sources": [] }));

    let missing = cal.ok(
        "calendar_update_source_selection",
        json!({ "input": { "id": "nope", "isSelected": true }}),
    );
    assert_eq!(missing["success"], false);
    assert_eq!(missing["source"], Value::Null);
    assert!(!missing["error"].as_str().unwrap().is_empty());
}
