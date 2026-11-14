//! The journal calendar's, charts' and day panel's commands through the IPC a renderer calls, on a mock app over a real
//! vault, vault tier and note index (#3530 13m-4, 13m-4b, On this day #4411): the argument names the generated bindings
//! send, the contract's field names in the answers, and a year out of range refused by its code.

mod support;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::notes::links::NoteLinks;
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
            memry_tauri::commands::journal::journal_get_same_day_entries::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_streak::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_year_stats::<MockRuntime>,
            memry_tauri::commands::journal::journal_update_entry::<MockRuntime>,
            memry_tauri::commands::notes::notes_rename::<MockRuntime>,
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

    assert_eq!(
        call(
            "journal_get_same_day_entries",
            json!({ "date": "2026-03-03" })
        ),
        Ok(json!([{
            "id": "j2025-03-03",
            "date": "2025-03-03",
            "preview": "A walk.",
            "content": "A walk.",
            "wordCount": 2,
        }]))
    );
    assert_eq!(
        call(
            "journal_get_same_day_entries",
            json!({ "date": "2025-03-03" })
        ),
        Ok(json!([])),
        "the day itself is not another year"
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

/// Every journal event heard on `mocked`'s app, with the day's index count when it went out.
fn hear(mocked: &Mocked) -> Arc<Heard> {
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
    heard
}

/// The app's own saves send their events from the commands, never as outside edits: across the
/// index pass and the watcher's report after them, no event says `source` (an `external` update
/// drops what the open editor has not saved).
#[test]
fn the_apps_own_day_saves_send_no_outside_event() {
    let mocked = opened();
    let heard = hear(&mocked);
    let call = |cmd: &str, args: Value| mocked.invoke(cmd, args).unwrap();
    call(
        "journal_create_entry",
        json!({ "input": { "date": "2025-03-12", "content": "Saved." } }),
    );
    call(
        "journal_update_entry",
        json!({ "input": { "date": "2025-03-12", "content": "Saved again." } }),
    );
    // timing-bound: past the index's idle delay and the watcher's debounce.
    std::thread::sleep(Duration::from_millis(2500));
    let heard = heard.lock().unwrap();
    let names: Vec<&str> = heard.iter().map(|(name, _, _)| *name).collect();
    assert_eq!(
        names,
        [
            JournalEntryCreatedEvent::NAME,
            JournalEntryUpdatedEvent::NAME
        ]
    );
    for (name, payload, _) in heard.iter() {
        assert!(payload.get("source").is_none(), "{name}: {payload}");
    }
}

/// A day file that appears, is edited and is removed outside the app sends
/// `journal:entryCreated`, `entryUpdated` and `entryDeleted` with `source: 'external'`, the
/// first two once the index measured the file: the calendar's refetch on them reads its counts.
#[test]
fn a_day_file_changed_outside_sends_its_journal_event_once_measured() {
    let mocked = opened();
    let heard = hear(&mocked);
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

/// Waits until the vault has a row for the file at `path`; its note id.
fn row_at(mocked: &Mocked, path: &str) -> String {
    let open = mocked.session().current().unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(row) = open.vault.note_files().by_path(path).unwrap() {
            return row.note_id;
        }
        assert!(Instant::now() < deadline, "{path} was never found");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Moves `Note.md`, made outside the app, to `daily/2025-03-12.md` once the day's record holds
/// `journal/2025-03-12.md` and the config names `daily`: the note stays the note there, owed,
/// since the day is here already (`crossed`). Heard from then on.
fn note_moved_to_a_days_path(mocked: &Mocked) -> Arc<Heard> {
    mocked
        .invoke(
            "journal_create_entry",
            json!({ "input": { "date": "2025-03-12", "content": "The day." } }),
        )
        .unwrap();
    fs::write(mocked.vault.join("Note.md"), "A note.\n").unwrap();
    let note = row_at(mocked, "Note.md");
    fs::write(
        mocked.vault.join(".memry/config.json"),
        r#"{"journalFolder":"daily","journalDateFormat":"YYYY-MM-DD"}"#,
    )
    .unwrap();
    fs::create_dir_all(mocked.vault.join("daily")).unwrap();
    fs::rename(
        mocked.vault.join("Note.md"),
        mocked.vault.join("daily/2025-03-12.md"),
    )
    .unwrap();
    assert_eq!(row_at(mocked, "daily/2025-03-12.md"), note);
    hear(mocked)
}

/// Settles the facts before `Marker.md`'s; the events of those facts follow a measure.
fn settle(mocked: &Mocked) {
    fs::write(mocked.vault.join("Marker.md"), "Done.\n").unwrap();
    row_at(mocked, "Marker.md");
    // timing-bound: the edit's fact is before the marker's; its event follows a measure.
    std::thread::sleep(Duration::from_millis(1500));
}

/// A note at a day's path that is not the day's sends no event of the day's when edited.
#[test]
fn a_note_at_a_days_path_sends_no_event_of_the_days() {
    let mocked = opened();
    let heard = note_moved_to_a_days_path(&mocked);
    fs::write(
        mocked.vault.join("daily/2025-03-12.md"),
        "A note, edited.\n",
    )
    .unwrap();
    settle(&mocked);
    assert_eq!(*heard.lock().unwrap(), Vec::new());
}

/// Nor when removed: the day lives on in its own file.
#[test]
fn a_note_removed_from_a_days_path_deletes_no_day() {
    let mocked = opened();
    let heard = note_moved_to_a_days_path(&mocked);
    fs::remove_file(mocked.vault.join("daily/2025-03-12.md")).unwrap();
    settle(&mocked);
    assert_eq!(*heard.lock().unwrap(), Vec::new());
}

/// The first event heard that `matches`, once it is.
fn heard_where(heard: &Heard, matches: impl Fn(&str, &Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let found = heard
            .lock()
            .unwrap()
            .iter()
            .find(|(name, payload, _)| matches(name, payload))
            .map(|(_, payload, _)| payload.clone());
        if let Some(payload) = found {
            return payload;
        }
        assert!(Instant::now() < deadline, "no such journal event");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A day's links to a renamed note follow it, and the open day hears it as an outside edit,
/// as Electron's `landSourceRewrite` sends `journal:entryUpdated` (#3530 13m-7b).
#[test]
fn a_days_links_to_a_renamed_note_reach_it_as_an_outside_edit() {
    let mocked = opened();
    let heard = hear(&mocked);
    fs::write(mocked.vault.join("Walk.md"), "A walk note.\n").unwrap();
    fs::write(
        mocked.vault.join("journal/2025-03-05.md"),
        "Went on a [[Walk]].\n",
    )
    .unwrap();
    let walk = row_at(&mocked, "Walk.md");
    let links = NoteLinks::new(&mocked.session().current().unwrap());
    let deadline = Instant::now() + WAIT;
    while links.get(&walk).unwrap().incoming.is_empty() {
        assert!(Instant::now() < deadline, "the day's link was not indexed");
        std::thread::sleep(Duration::from_millis(20));
    }

    mocked
        .invoke("notes_rename", json!({ "id": walk, "newTitle": "Run" }))
        .unwrap();
    assert_eq!(
        fs::read_to_string(mocked.vault.join("journal/2025-03-05.md")).unwrap(),
        "Went on a [[Run]].\n"
    );
    let payload = heard_where(&heard, |name, payload| {
        name == JournalEntryUpdatedEvent::NAME
            && payload["entry"]["content"]
                .as_str()
                .is_some_and(|content| content.contains("[[Run]]"))
    });
    assert_eq!(
        (&payload["date"], &payload["source"]),
        (&json!("2025-03-05"), &json!("external"))
    );
}
