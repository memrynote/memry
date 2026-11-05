//! Relation chips (`properties:resolveRefs`, #3530 13q-2) over a real session, tier and index:
//! each kind's target resolved through its owner's read, the answer one to one with the input,
//! and a malformed value, a missing target or one that cannot be read `exists: false` rather
//! than an error. No read needs this device's identity.
//! The imported event and its promotion are `memry-core`'s `calendar_external_relation` test.

use memry_core::api::calendar_records::CalendarEventDraft;
use memry_core::api::errors::StorageError;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStoreKey;
use memry_desktop::notes::properties::resolve_refs::ResolvedRelationRefView;
use memry_desktop::notes::update::NoteUpdateInput;
use serde_json::{Value, json};

use crate::notes_link_rewrite::{id_at, opened};

fn as_json(views: &[ResolvedRelationRefView]) -> Value {
    serde_json::to_value(views).unwrap()
}

#[test]
fn each_kind_resolves_through_its_owner_and_a_bad_ref_is_missing() {
    let (e, notes, store) = opened(&[
        ("Plan.md", "The plan.\n"),
        ("journal/2026-03-05.md", "A day.\n"),
    ]);
    let open = e.session.current().unwrap();
    let note = id_at(&e, "Plan.md");
    notes
        .update(
            &open,
            NoteUpdateInput {
                id: note.clone(),
                emoji: Some(Some("🗺️".into())),
                ..NoteUpdateInput::default()
            },
        )
        .unwrap();

    let tasks = open.vault.tasks(store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Home".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let task = tasks
        .create(NewTaskInput {
            title: "Call the bank".into(),
            project_id: project.clone(),
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .unwrap()
        .created[0]
        .clone();
    let event = open
        .vault
        .calendar(store.clone())
        .unwrap()
        .create_event(CalendarEventDraft {
            title: "Dentist".into(),
            description: None,
            location: None,
            start_at: "2026-03-05T09:00:00.000Z".into(),
            end_at: None,
            timezone: "UTC".into(),
            is_all_day: false,
            target_calendar_id: None,
            color: None,
        })
        .unwrap();
    let canvases = open.vault.canvases(store.clone()).unwrap();
    let board = canvases.create(Some("Board".into()), None, None).unwrap();

    let uris: Vec<String> = [
        format!("memry://note/{note}"),
        format!("memry://task/{task}"),
        format!("memry://event/{}", event.id),
        format!("memry://canvas/{}", board.id),
        "memry://journal/2026-03-05".to_owned(),
        "memry://canvas/c-none".to_owned(),
        "memry://journal/2026-03-06".to_owned(),
        "memry://note/n-none".to_owned(),
        // `ext-none` in base64url: an imported event this vault does not hold.
        "memry://external-event/ZXh0LW5vbmU".to_owned(),
        "memry://external-event/!!".to_owned(),
        "memry://journal/2026-3-5".to_owned(),
    ]
    .into();
    let resolved = notes.resolve_refs(&open, &uris);
    assert_eq!(
        as_json(&resolved),
        json!([
            { "uri": uris[0], "targetType": "note", "targetId": note, "title": "Plan",
              "exists": true, "emoji": "🗺️" },
            { "uri": uris[1], "targetType": "task", "targetId": task, "title": "Call the bank",
              "exists": true, "projectId": project },
            { "uri": uris[2], "targetType": "event", "targetId": event.id, "title": "Dentist",
              "exists": true, "startAt": "2026-03-05T09:00:00.000Z",
              "calendarItemId": event.id },
            { "uri": uris[3], "targetType": "canvas", "targetId": board.id, "title": "Board",
              "exists": true },
            { "uri": uris[4], "targetType": "journal", "targetId": "2026-03-05",
              "title": "2026-03-05", "exists": true, "date": "2026-03-05" },
            { "uri": uris[5], "targetType": "canvas", "targetId": "c-none", "title": "",
              "exists": false },
            { "uri": uris[6], "targetType": "journal", "targetId": "2026-03-06", "title": "",
              "exists": false },
            { "uri": uris[7], "targetType": "note", "targetId": "n-none", "title": "",
              "exists": false },
            { "uri": uris[8], "targetType": "external-event", "targetId": "ZXh0LW5vbmU",
              "title": "", "exists": false },
            { "uri": uris[9], "targetType": "note", "targetId": "", "title": "", "exists": false },
            { "uri": uris[10], "targetType": "note", "targetId": "", "title": "", "exists": false },
        ])
    );
    assert!(notes.resolve_refs(&open, &[]).is_empty());
}

/// One target that cannot be read (a canvas whose payload is not JSON) is `exists: false` and
/// the refs beside it still resolve, with the device signing key gone, as a locked keychain
/// leaves it.
#[test]
fn a_ref_that_cannot_be_read_is_missing_and_no_read_needs_the_device_identity() {
    let (e, notes, store) = opened(&[("Plan.md", "The plan.\n")]);
    let open = e.session.current().unwrap();
    let note = id_at(&e, "Plan.md");
    let board = open
        .vault
        .canvases(store.clone())
        .unwrap()
        .create(Some("Board".into()), None, None)
        .unwrap();
    open.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('canvas', 'c-bad', 'not json', 'present', 0)",
                [],
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .unwrap();
    store.delete(SecureStoreKey::DeviceSigningKey).unwrap();

    let uris = vec![
        "memry://canvas/c-bad".to_owned(),
        format!("memry://note/{note}"),
        format!("memry://canvas/{}", board.id),
        "memry://task/t-none".to_owned(),
    ];
    let resolved = notes.resolve_refs(&open, &uris);
    let shown: Vec<(bool, &str)> = resolved
        .iter()
        .map(|view| (view.exists, view.title.as_str()))
        .collect();
    assert_eq!(
        shown,
        [(false, ""), (true, "Plan"), (true, "Board"), (false, "")]
    );
}
