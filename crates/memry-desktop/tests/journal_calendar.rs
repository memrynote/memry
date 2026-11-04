//! The journal calendar's reads (Step 13m-4, #3530) over a running vault and note index: the
//! days are the live journal records, a day with a file is measured by the index's row of that
//! file, a day with no file yet by its text, and a deleted day never shows, its file on disk or
//! not.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::calendar::{
    self, HeatmapEntryView, MonthEntryView, MonthStatsView, StreakView,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
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

    assert_eq!(
        calendar::streak(&journal).unwrap(),
        StreakView {
            current_streak: 0,
            longest_streak: 3,
            last_entry_date: Some("2025-03-05".into()),
        },
        "the deleted 6th does not extend the run"
    );

    assert!(calendar::heatmap(&open, &journal, 1969).is_err());
    assert!(calendar::month_entries(&open, &journal, 2025, 13).is_err());
    e.close();
}
