//! The journal calendar's and charts' commands through the IPC a renderer calls, on a mock app over a real
//! vault, vault tier and note index (#3530 13m-4, 13m-4b): the argument names the generated bindings
//! send, the contract's field names in the answers, and a year out of range refused by its code.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::test::MockRuntime;
use tauri_specta::{ErrorHandlingMode, collect_commands};

/// A vault holding one day file, opened with its first walk done and the file measured, and a
/// webview whose IPC routes the calendar and chart commands and the journal saves.
fn opened() -> Mocked {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::journal::journal_create_entry::<MockRuntime>,
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
        call("journal_get_property_rows", json!({ "from": "2025-03-01", "to": "2025-03-31" })),
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
