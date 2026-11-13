//! On this day (`journal:getSameDayEntries`, #4411) over a running vault: the live days of other
//! years that show as the same date, newest first, Feb 29 on Feb 28 of a non-leap year, a day
//! without text left out, and a day made on another device read from its record.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::same_day::{SameDayEntryView, same_day_entries};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use vault_env::{env, indexed};

#[test]
fn on_this_day_lists_other_years_newest_first_with_leap_days_on_feb_28() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    for (date, text) in [
        ("2022-03-01", "March, not February."),
        ("2023-02-28", "A plain Feb 28."),
        ("2024-02-28", "The day before the leap day."),
        ("2024-02-29", "Leap **day**."),
        ("2025-02-28", "This year."),
        ("2026-02-27", "Off by one."),
        ("2027-02-28", "  \n"),
    ] {
        e.write(
            &format!("journal/{date}.md"),
            &format!("---\ndate: {date}\n---\n{text}"),
        );
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().unwrap();
    let journal = open
        .vault
        .journal(store.lock().unwrap().clone().unwrap())
        .unwrap();
    // A day made on another device: a record and a text, no file here yet.
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "Synced in.".into(),
        new_block_id: "b-synced".into(),
    };
    journal.edit_day("2021-02-28".into(), edit).unwrap();
    let dates = |date: &str| -> Vec<String> {
        same_day_entries(&open, &journal, date)
            .unwrap()
            .into_iter()
            .map(|entry| entry.date)
            .collect()
    };

    // The issue's case: 2024-02-29 and 2023-02-28 for 2025-02-28, not 2022-03-01; the empty
    // 2027-02-28 is left out, the leap year's 2024-02-28 is its own Feb 28 and shows too.
    assert_eq!(
        dates("2025-02-28"),
        ["2024-02-29", "2024-02-28", "2023-02-28", "2021-02-28"]
    );
    // `journal-queries` case: a leap day shows the non-leap Feb 28s, not 2024-02-28.
    assert_eq!(
        dates("2028-02-29"),
        ["2025-02-28", "2024-02-29", "2023-02-28", "2021-02-28"]
    );
    // A leap year's Feb 28 keeps to its own day.
    assert_eq!(
        dates("2028-02-28"),
        ["2025-02-28", "2024-02-28", "2023-02-28", "2021-02-28"]
    );
    assert!(dates("2025-06-01").is_empty());

    let entries = same_day_entries(&open, &journal, "2025-02-28").unwrap();
    assert_eq!(
        entries[0],
        SameDayEntryView {
            id: "j2024-02-29".into(),
            date: "2024-02-29".into(),
            preview: "Leap day.".into(),
            content: "Leap **day**.".into(),
            word_count: 2,
        },
        "the file's text below the frontmatter, its preview plain"
    );
    assert_eq!(
        (entries[3].content.as_str(), entries[3].word_count),
        ("Synced in.", 2),
        "a day with no file reads from its record"
    );

    // A deleted day never shows, its file on disk or not.
    assert!(journal.delete_day("2024-02-29".into()).unwrap());
    assert_eq!(
        dates("2025-02-28"),
        ["2024-02-28", "2023-02-28", "2021-02-28"]
    );

    assert!(same_day_entries(&open, &journal, "2025-02-30").is_err());
    e.close();
}
