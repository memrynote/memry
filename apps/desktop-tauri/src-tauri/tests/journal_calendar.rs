//! The journal calendar's, charts' and day panel's commands through the IPC a renderer calls, on a mock app over a real
//! vault, vault tier and note index (#3530 13m-4, 13m-4b): the argument names the generated bindings
//! send, the contract's field names in the answers, and a year out of range refused by its code.

mod support;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::session::Session;
use memry_tauri::events::{
    JournalEntryCreatedEvent, JournalEntryDeletedEvent, JournalEntryUpdatedEvent,
};
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::Event;
use tauri_specta::{ErrorHandlingMode, collect_commands};

/// A vault holding one day file, opened with its first walk done and the file measured, and a
/// webview whose IPC routes the calendar, chart and day panel commands and the journal saves.
fn opened() -> Mocked {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::journal::journal_create_entry::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_day_context::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_heatmap::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_month_entries::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_property_rows::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_streak::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_year_stats::<MockRuntime>,
            memry_tauri::commands::journal::journal_update_entry::<MockRuntime>,
        ]);
    let mocked = Mocked::open(
        &[("journal/2025-03-03.md", "---\ntags: [walk]\n---\nA walk.\n")],
        commands,
    );
    let open = mocked.session().current().unwrap();
    let deadline = Instant::now() + WAIT;
    while open.search.note_stats("j2025-03-03").unwrap().is_none() {
        assert!(Instant::now() < deadline, "the day file was not measured");
        std::thread::sleep(Duration::from_millis(20));
    }
    mocked
}

#[test]
fn the_calendar_commands_answer_the_contracts_shapes() {
    let mocked = opened();
    let call = |cmd: &str, args: Value| mocked.invoke(cmd, args);

    assert_eq!(
        call("journal_get_heatmap", json!({ "year": 2025 })),
        Ok(json!([{ "date": "2025-03-03", "characterCount": 8, "level": 1 }]))
    );
    assert_eq!(
        call(
            "journal_get_month_entries",
            json!({ "year": 2025, "month": 3 })
        ),
        Ok(json!([{
            "date": "2025-03-03",
            "preview": "A walk.",
            "wordCount": 2,
            "characterCount": 8,
            "activityLevel": 1,
            "tags": ["walk"],
        }]))
    );
    assert_eq!(
        call("journal_get_year_stats", json!({ "year": 2025 })),
        Ok(json!([{
            "year": 2025,
            "month": 3,
            "entryCount": 1,
            "totalWordCount": 2,
            "totalCharacterCount": 8,
            "averageLevel": 1.0,
        }]))
    );
    assert_eq!(
        call("journal_get_streak", json!({})),
        Ok(json!({ "currentStreak": 0, "longestStreak": 1, "lastEntryDate": "2025-03-03" }))
    );

    assert_eq!(
        call(
            "journal_get_property_rows",
            json!({ "from": "2025-03-01", "to": "2025-03-31" })
        ),
        Ok(json!({
            "rows": [{
                "id": "j2025-03-03",
                "date": "2025-03-03",
                "path": "journal/2025-03-03.md",
                "title": "2025-03-03",
                "properties": {},
            }],
            "properties": [],
        }))
    );

    assert_eq!(
        call("journal_get_day_context", json!({ "date": "2025-03-03" })),
        Ok(json!({ "date": "2025-03-03", "tasks": [], "events": [], "overdueCount": 0 }))
    );

    let refused = call("journal_get_heatmap", json!({ "year": 1969 })).unwrap_err();
    assert_eq!(
        (&refused["kind"], &refused["code"]),
        (&json!("invalid"), &json!("invalid"))
    );
}

/// The renderer refetches the calendar on the save's event, sent before the command answers:
/// the first read after it has the saved text's counts, with no index pass in between.
#[test]
fn a_read_straight_after_a_save_has_the_saved_counts() {
    let mocked = opened();
    let call = |cmd: &str, args: Value| mocked.invoke(cmd, args);
    call(
        "journal_create_entry",
        json!({ "input": { "date": "2025-03-10", "content": "Rain all day." } }),
    )
    .unwrap();
    assert!(mocked.vault.join("journal/2025-03-10.md").is_file());
    assert_eq!(
        call("journal_get_heatmap", json!({ "year": 2025 })),
        Ok(json!([
            { "date": "2025-03-03", "characterCount": 8, "level": 1 },
            { "date": "2025-03-10", "characterCount": 14, "level": 1 },
        ]))
    );

    let long = "word ".repeat(95);
    call(
        "journal_update_entry",
        json!({ "input": { "date": "2025-03-10", "content": long } }),
    )
    .unwrap();
    let month = call(
        "journal_get_month_entries",
        json!({ "year": 2025, "month": 3 }),
    )
    .unwrap();
    assert_eq!(
        (
            &month[0]["date"],
            &month[0]["characterCount"],
            &month[0]["activityLevel"]
        ),
        (&json!("2025-03-10"), &json!(475), &json!(2))
    );
}

/// (event, payload, the day's character count in the index when the event went out)
type Heard = Mutex<Vec<(&'static str, Value, Option<u32>)>>;

/// The `count`th event heard, once it is.
fn nth(heard: &Heard, count: usize) -> (&'static str, Value, Option<u32>) {
    let deadline = Instant::now() + WAIT;
    while heard.lock().unwrap().len() < count {
        assert!(Instant::now() < deadline, "no journal event {count}");
        std::thread::sleep(Duration::from_millis(20));
    }
    heard.lock().unwrap()[count - 1].clone()
}

/// A day file that appears, is edited and is removed outside the app sends
/// `journal:entryCreated`, `entryUpdated` and `entryDeleted` with `source: 'external'`, the
/// first two once the index measured the file: the calendar's refetch on them reads its counts.
#[test]
fn a_day_file_changed_outside_sends_its_journal_event_once_measured() {
    let mocked = opened();
    let heard: Arc<Heard> = Arc::default();
    for name in [
        JournalEntryCreatedEvent::NAME,
        JournalEntryUpdatedEvent::NAME,
        JournalEntryDeletedEvent::NAME,
    ] {
        let sink = heard.clone();
        let app = mocked.webview.app_handle().clone();
        mocked.webview.app_handle().listen_any(name, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            let open = app.state::<Session>().current().unwrap();
            let counted = open
                .search
                .note_stats("j2025-03-12")
                .unwrap()
                .map(|row| row.stats.character_count);
            sink.lock().unwrap().push((name, payload, counted));
        });
    }
    let next = |count: usize| nth(&heard, count);

    let file = mocked.vault.join("journal/2025-03-12.md");
    fs::write(&file, "Outside.\n").unwrap();
    let (name, payload, counted) = next(1);
    assert_eq!(name, JournalEntryCreatedEvent::NAME);
    assert_eq!(
        (
            &payload["date"],
            &payload["source"],
            &payload["entry"]["content"]
        ),
        (&json!("2025-03-12"), &json!("external"), &json!("Outside."))
    );
    assert_eq!(counted, Some(9));

    fs::write(&file, "Outside, and longer now.\n").unwrap();
    let (name, payload, counted) = next(2);
    assert_eq!(name, JournalEntryUpdatedEvent::NAME);
    assert_eq!(payload["source"], json!("external"));
    assert_eq!(
        payload["entry"]["content"],
        json!("Outside, and longer now.")
    );
    assert_eq!(counted, Some(25));

    fs::remove_file(&file).unwrap();
    let (name, payload, _) = next(3);
    assert_eq!(name, JournalEntryDeletedEvent::NAME);
    assert_eq!(
        payload,
        json!({ "date": "2025-03-12", "source": "external" })
    );
}
