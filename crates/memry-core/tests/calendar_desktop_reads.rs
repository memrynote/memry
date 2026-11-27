//! Desktop's calendar reads against real SQLite (#3546 29b): the range's task items with their
//! status meta and duration blocks (`projection.ts:252-307`), `SEARCH_EVENTS`'s title search
//! (`calendar-handlers.ts:361-386`) and the event card's linked notes (`linked-notes.ts`).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use memry_core::domain::calendar_items::event_search;
use memry_core::domain::calendar_items::linked_notes::{LinkedNote, linked_notes};
use memry_core::domain::calendar_items::projection::{self, RangeInput};
use memry_core::domain::calendar_items::write::{self, NewEvent};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data, open_index};
use rusqlite::params;
use serde_json::{Value, json};

const NOW: i64 = 1_790_380_800_000; // 2026-09-26T00:00:00Z

fn scratch() -> std::path::PathBuf {
    tempfile::Builder::new()
        .prefix("memry-cal-desktop-")
        .tempdir()
        .expect("the scratch directory")
        .keep()
}

fn inbound(item_type: &str, id: &str, payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    }
}

fn range_input(include_completed_tasks: bool) -> RangeInput {
    RangeInput {
        start_at: "2026-09-28T00:00:00.000Z".into(),
        end_at: "2026-10-05T00:00:00.000Z".into(),
        include_unselected_sources: false,
        include_completed_tasks,
        include_external: true,
        external_providers: None,
        enabled_property_names: vec![],
        show_notes_by_created: false,
        local_timezone: "UTC".into(),
    }
}

#[test]
fn tasks_carry_their_status_and_a_duration_makes_a_resizable_block() {
    let db = open_data(&scratch().join("data.db")).expect("open data.db");
    let tasks = [
        (
            "t-block",
            json!({"dueTime": "09:30", "durationMinutes": 45, "statusId": "s-doing"}),
        ),
        ("t-point", json!({"dueTime": "11:00"})),
        ("t-day", json!({"durationMinutes": 30})),
        (
            "t-done",
            json!({"dueTime": "08:00", "completedAt": "2026-09-27T10:00:00.000Z"}),
        ),
    ];
    db.call_blocking(move |conn| {
        for (id, extra) in &tasks {
            let mut payload = json!({
                "title": id, "projectId": "proj-1", "dueDate": "2026-09-29",
                "clock": {"device-b": 1}
            });
            for (key, value) in extra.as_object().expect("an object") {
                payload[key] = value.clone();
            }
            sync_items::apply_remote(conn, &inbound("task", id, &payload), NOW)?;
        }
        Ok(())
    })
    .expect("seed");
    let read = |completed: bool| {
        db.read_blocking(move |conn| {
            projection::range(conn, &FixedZone(0), &range_input(completed))
        })
        .expect("range")
    };

    let open = read(false);
    let ids: Vec<&str> = open.iter().map(|i| i.source_id.as_str()).collect();
    assert_eq!(ids, ["t-day", "t-block", "t-point"]);
    let block = &open[1];
    assert_eq!(block.start_at, "2026-09-29T09:30:00.000Z");
    assert_eq!(block.end_at.as_deref(), Some("2026-09-29T10:15:00.000Z"));
    assert!(block.editability.can_resize);
    let meta = block.task.as_ref().expect("task meta");
    assert_eq!(meta.project_id, "proj-1");
    assert_eq!(meta.status_id.as_deref(), Some("s-doing"));
    assert!(!meta.is_completed);
    // A timed task without a duration is a point; an all-day task ignores its duration.
    assert_eq!(open[2].end_at, None);
    assert!(!open[2].editability.can_resize);
    assert_eq!(open[0].end_at.as_deref(), Some("2026-09-30T00:00:00.000Z"));
    assert!(!open[0].editability.can_resize);

    let all = read(true);
    let done = all
        .iter()
        .find(|i| i.source_id == "t-done")
        .expect("a completed task stays in the range when asked");
    assert!(done.task.as_ref().expect("task meta").is_completed);
}

fn event(conn: &rusqlite::Connection, title: &str, start: &str) -> String {
    write::create_event(
        conn,
        &NewEvent {
            title: title.into(),
            start_at: start.into(),
            timezone: "UTC".into(),
            ..NewEvent::default()
        },
        "desk",
        NOW,
    )
    .expect("create")
}

/// A selected Google calendar and one event mirrored from it.
fn seed_mirror(conn: &rusqlite::Connection) {
    let source = json!({
        "id": "src-work", "provider": "google", "kind": "calendar", "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com", "title": "Work", "isSelected": true,
        "isPrimary": false, "isMemryManaged": false, "clock": { "desktop": 1 },
        "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    let mirror = json!({
        "id": "ext-1", "sourceId": "src-work", "remoteEventId": "g-1",
        "title": "Standup with Google", "startAt": "2026-09-26T03:00:00.000Z",
        "endAt": "2026-09-26T03:30:00.000Z", "isAllDay": false, "status": "confirmed",
        "clock": { "desktop": 2 },
        "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    memry_core::sync::apply::apply_inbound(
        conn,
        &inbound("calendar_source", "src-work", &source),
        1,
    )
    .expect("source");
    memry_core::sync::apply::apply_inbound(
        conn,
        &inbound("calendar_external_event", "ext-1", &mirror),
        1,
    )
    .expect("mirror");
}

#[test]
fn title_search_takes_the_nearest_matches_and_adds_imported_events_on_request() {
    let db = open_data(&scratch().join("data.db")).expect("open data.db");
    let ids = db
        .call_blocking(|conn| {
            seed_mirror(conn);
            Ok([
                event(conn, "Weekly STANDUP", "2026-09-26T05:00:00.000Z"),
                event(conn, "Standup retro", "2026-09-20T09:00:00.000Z"),
                event(conn, "standup far", "2027-01-01T09:00:00.000Z"),
                event(conn, "Lunch", "2026-09-26T01:00:00.000Z"),
            ])
        })
        .expect("seed");
    let now = "2026-09-26T00:00:00.000Z";
    let search = |limit: usize, external: bool| {
        db.read_blocking(move |conn| event_search::search(conn, "stand", limit, now, external))
            .expect("search")
    };

    let native = search(2, false);
    let found: Vec<&str> = native.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(
        found,
        [ids[0].as_str(), ids[1].as_str()],
        "nearest first, cut at 2"
    );
    assert!(native.iter().all(|h| !h.external));

    let with_external = search(2, true);
    assert_eq!(with_external[0].id, "ext-1", "3 h away beats 5 h away");
    assert!(with_external[0].external);
    assert_eq!(with_external[1].id, ids[0]);
    assert_eq!(with_external.len(), 2);

    assert!(search(5, true).iter().all(|h| h.id != ids[3]));
    let blank = db
        .read_blocking(move |conn| event_search::search(conn, "  ", 5, now, true))
        .expect("search");
    assert!(blank.is_empty());
}

#[test]
fn linked_notes_count_links_to_the_mirror_a_native_event_was_promoted_from() {
    let dir = scratch();
    let data: Db = open_data(&dir.join("data.db")).expect("open data.db");
    let index = open_index(&dir.join("index.db")).expect("open index.db").db;
    let promoted = data
        .call_blocking(|conn| {
            seed_mirror(conn);
            for (id, title, emoji) in [
                ("note-a", "Beta", None),
                ("note-b", "Alpha", Some("📅")),
                ("note-c", "Gamma", None),
            ] {
                conn.execute(
                    "INSERT INTO notes (id, title, emoji, folder_path, file_type, created_at,
                                        modified_at)
                     VALUES (?1, ?2, ?3, '', 'markdown', 0, 0)",
                    params![id, title, emoji],
                )
                .expect("note");
            }
            Ok(write::promote(conn, "ext-1", "desk", NOW)?.expect("a promotable mirror"))
        })
        .expect("seed");
    let mirror_ref = URL_SAFE_NO_PAD.encode("ext-1");
    let event_id = promoted.clone();
    index
        .call_blocking(move |conn| {
            for (note, kind, target) in [
                ("note-a", "event", event_id.as_str()),
                ("note-b", "external-event", mirror_ref.as_str()),
                ("note-c", "event", "some-other-event"),
            ] {
                conn.execute(
                    "INSERT INTO property_refs (source_id, name, target_type, target_id)
                     VALUES (?1, 'meeting', ?2, ?3)",
                    params![note, kind, target],
                )
                .expect("ref");
            }
            Ok(())
        })
        .expect("refs");
    let read = |source_type: &'static str, id: String| {
        let index = index.clone();
        data.read_blocking(move |data| {
            index.read_blocking(|index| linked_notes(data, index, source_type, &id))
        })
        .expect("linked notes")
    };

    assert_eq!(
        read("event", promoted),
        [
            LinkedNote {
                id: "note-b".into(),
                title: "Alpha".into(),
                emoji: Some("📅".into()),
            },
            LinkedNote {
                id: "note-a".into(),
                title: "Beta".into(),
                emoji: None,
            },
        ]
    );
    let mirror_only: Vec<String> = read("external_event", "ext-1".into())
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(mirror_only, ["note-b"]);
}
