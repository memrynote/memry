//! The journal calendar's reads (Step 13m-4, #3530) over a running vault and note index: the
//! days are the live journal records, a day with a file is measured by the index's row of that
//! file, a day with no file yet by its text, and a deleted day never shows, its file on disk or
//! not. The charts' property rows (13m-4b) are the records' values, and the day panel's
//! context the tasks store's.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::calendar::{self, HeatmapEntryView, MonthEntryView, MonthStatsView};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::property_definitions::PropertyDefinitions;
use memry_desktop::notes::service::NotesService;
use serde_json::json;
use vault_env::{env, indexed};

#[test]
fn the_calendar_lists_live_days_measured_from_their_files_or_their_text() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    e.write(
        "journal/2025-02-10.md",
        "---\ndate: 2025-02-10\n---\nFebruary.\n",
    );
    e.write(
        "journal/2025-03-03.md",
        "---\ndate: 2025-03-03\ntags: [walk]\n---\nA long **walk** by the river.\n",
    );
    e.write("journal/2025-03-04.md", "Short.\n");
    e.write("journal/2025-03-06.md", "Gone.\n");
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().unwrap();
    let journal = open
        .vault
        .journal(store.lock().unwrap().clone().unwrap())
        .unwrap();
    for date in ["2025-02-10", "2025-03-03", "2025-03-04"] {
        until("the day files measured", || {
            open.search
                .note_stats(&format!("j{date}"))
                .unwrap()
                .is_some()
        });
    }
    // A day made on another device: a record and a text, no file here yet.
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "Synced in.".into(),
        new_block_id: "b-synced".into(),
    };
    journal.edit_day("2025-03-05".into(), edit).unwrap();
    journal
        .set_tags("2025-03-05".into(), vec!["sync".into()])
        .unwrap();
    // A deleted day whose file is still on disk.
    assert!(journal.delete_day("2025-03-06".into()).unwrap());

    let heat = |date: &str, character_count, level| HeatmapEntryView {
        date: date.into(),
        character_count,
        level,
    };
    assert_eq!(
        calendar::heatmap(&open, &journal, 2025).unwrap(),
        [
            heat("2025-02-10", 10, 1),
            heat("2025-03-03", 30, 1),
            heat("2025-03-04", 7, 1),
            heat("2025-03-05", 10, 1),
        ],
        "the bodies' lengths below the frontmatter, oldest first"
    );

    let day =
        |date: &str, preview: &str, word_count, character_count, tags: &[&str]| MonthEntryView {
            date: date.into(),
            preview: preview.into(),
            word_count,
            character_count,
            activity_level: 1,
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        };
    assert_eq!(
        calendar::month_entries(&open, &journal, 2025, 3).unwrap(),
        [
            day("2025-03-05", "Synced in.", 2, 10, &["sync"]),
            day("2025-03-04", "Short.", 1, 7, &[]),
            day("2025-03-03", "A long walk by the river.", 6, 30, &["walk"]),
        ],
        "newest first; a file's header tags, a day with no file its record's"
    );
    assert_eq!(
        calendar::month_entries(&open, &journal, 2025, 4).unwrap(),
        []
    );

    let month = |month, entry_count, total_word_count, total_character_count| MonthStatsView {
        year: 2025,
        month,
        entry_count,
        total_word_count,
        total_character_count,
        average_level: 1.0,
    };
    assert_eq!(
        calendar::year_stats(&open, &journal, 2025).unwrap(),
        [month(2, 1, 1, 10), month(3, 3, 9, 47)]
    );
    assert_eq!(calendar::year_stats(&open, &journal, 2024).unwrap(), []);

    // The run 3rd-5th, counted from the UTC date of the instant: on its last day and the day
    // after it is current, from two days after it is not. The deleted 6th does not extend it.
    const MARCH_6: u64 = 1_741_219_200_000;
    const DAY: u64 = 86_400_000;
    let streak = |now| {
        let streak = calendar::streak(&journal, now).unwrap();
        assert_eq!(
            (streak.longest_streak, streak.last_entry_date.as_deref()),
            (3, Some("2025-03-05"))
        );
        streak.current_streak
    };
    assert_eq!(streak(MARCH_6 - DAY), 3, "the 5th, at midnight");
    assert_eq!(
        streak(MARCH_6 - 1),
        3,
        "the 5th, a millisecond before midnight"
    );
    assert_eq!(
        streak(MARCH_6 + DAY - 1),
        3,
        "the 6th, a millisecond before midnight"
    );
    assert_eq!(streak(MARCH_6 + DAY), 0, "the 7th, at midnight");

    // `GetHeatmapInputSchema`'s 1970-2100 and a month 1-12.
    for year in [1970, 2100] {
        assert!(calendar::heatmap(&open, &journal, year).is_ok(), "{year}");
        assert!(
            calendar::year_stats(&open, &journal, year).is_ok(),
            "{year}"
        );
        assert!(
            calendar::month_entries(&open, &journal, year, 1).is_ok(),
            "{year}"
        );
    }
    assert!(calendar::month_entries(&open, &journal, 2025, 12).is_ok());
    for year in [1969, 2101] {
        assert!(calendar::heatmap(&open, &journal, year).is_err(), "{year}");
        assert!(
            calendar::year_stats(&open, &journal, year).is_err(),
            "{year}"
        );
        assert!(
            calendar::month_entries(&open, &journal, year, 1).is_err(),
            "{year}"
        );
    }
    for month in [0, 13] {
        assert!(
            calendar::month_entries(&open, &journal, 2025, month).is_err(),
            "{month}"
        );
    }
    e.close();
}

#[test]
fn the_charts_take_each_live_days_values_and_every_property_in_use() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    e.open();
    e.facts_until(indexed);
    let store = store.lock().unwrap().clone().unwrap();
    let open = e.session.current().unwrap();
    let journal = open.vault.journal(store.clone()).unwrap();
    let set = |date: &str, name: &str, value: &str| {
        journal
            .set_property(date.into(), name.into(), value.into())
            .unwrap();
    };
    set("2024-12-31", "done", "true");
    set("2025-03-01", "mood", "3");
    set("2025-03-01", "energy", "\"high\"");
    set("2025-03-02", "mood", "4");
    set("2025-03-02", "energy", "\"low\"");
    set("2025-03-03", "energy", "\"2025-03-03\"");
    set("2025-03-04", "mood", "5");
    assert!(journal.delete_day("2025-03-04".into()).unwrap());
    let mood = serde_json::from_value(json!({ "name": "mood", "type": "select" })).unwrap();
    PropertyDefinitions::open(&open, store.clone())
        .unwrap()
        .create(mood)
        .unwrap();

    let notes = NotesService::new(e.tier.clone(), store);
    let read = notes
        .journal_property_rows(&open, "2025-03-01", "2025-03-31")
        .unwrap();
    let rows = serde_json::to_value(&read.rows).unwrap();
    let row = |date: &str, properties| {
        json!({
            "id": format!("j{date}"),
            "date": date,
            "path": format!("journal/{date}.md"),
            "title": date,
            "properties": properties,
        })
    };
    assert_eq!(
        rows,
        json!([
            row("2025-03-01", json!({ "mood": 3, "energy": "high" })),
            row("2025-03-02", json!({ "mood": 4, "energy": "low" })),
            row("2025-03-03", json!({ "energy": "2025-03-03" })),
        ]),
        "the days in range, oldest first; the deleted 4th is not one"
    );
    assert_eq!(
        serde_json::to_value(&read.properties).unwrap(),
        json!([
            { "name": "energy", "type": "text", "count": 3 },
            { "name": "mood", "type": "select", "count": 2 },
            { "name": "done", "type": "checkbox", "count": 1 },
        ]),
        "every live day's: most used first, a definition's type, else most values'"
    );
    assert!(
        notes
            .journal_property_rows(&open, "2025-3-1", "2025-03-31")
            .is_err()
    );
    e.close();
}

#[test]
fn the_day_context_lists_the_days_tasks_and_counts_the_overdue_ones() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    e.open();
    let store = store.lock().unwrap().clone().unwrap();
    let open = e.session.current().unwrap();
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
    let task = |title: &str, due: &str, time: Option<&str>, priority| {
        let made = tasks
            .create(NewTaskInput {
                title: title.into(),
                project_id: project.clone(),
                status_id: None,
                parent_id: None,
                priority,
                description: None,
                due_date: Some(due.into()),
                due_time: time.map(str::to_owned),
                start_date: None,
                repeat: None,
                repeat_from: None,
                tags: Vec::new(),
                linked_note_ids: Vec::new(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .unwrap();
        made.created[0].clone()
    };
    let late = task("Late", "2025-03-01", None, 0);
    let late_done = task("Late, done", "2025-03-01", None, 0);
    tasks
        .complete(late_done.clone(), "2025-03-02T10:00:00".into())
        .unwrap();
    let late_archived = task("Late, archived", "2025-02-01", None, 0);
    let late_deleted = task("Late, deleted", "2025-02-01", None, 0);
    tasks.delete(late_deleted, false).unwrap();
    let afternoon = task("Afternoon", "2025-03-05", Some("15:00"), 3);
    let morning = task("Morning", "2025-03-05", Some("09:00"), 0);
    let anytime = task("Anytime", "2025-03-05", None, 4);
    tasks
        .complete(anytime.clone(), "2025-03-05T08:00:00".into())
        .unwrap();
    let shelved = task("Shelved", "2025-03-05", None, 1);
    tasks.bulk_archive(vec![late_archived, shelved]).unwrap();
    task("Tomorrow", "2025-03-06", None, 2);

    let notes = NotesService::new(e.tier.clone(), store);
    let context = notes.journal_day_context(&open, "2025-03-05").unwrap();
    assert_eq!(
        serde_json::to_value(&context).unwrap(),
        json!({
            "date": "2025-03-05",
            "tasks": [
                { "id": anytime, "title": "Anytime", "completed": true, "priority": "urgent", "isOverdue": false },
                { "id": morning, "title": "Morning", "completed": false, "isOverdue": false },
                { "id": afternoon, "title": "Afternoon", "completed": false, "priority": "high", "isOverdue": false },
            ],
            "events": [],
            "overdueCount": 1,
        }),
        "due that day and not archived, by time (none first); overdue: open, live, due before"
    );
    assert_eq!(
        notes
            .journal_day_context(&open, "2025-03-01")
            .unwrap()
            .tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        [late.as_str(), late_done.as_str()],
        "a day's completed task is listed too"
    );
    assert!(notes.journal_day_context(&open, "2025-3-5").is_err());
    e.close();
}
