//! Settings' property usage (`notes:get-property-usage`, `notes:list-notes-with-property`,
//! 2b3a512960) over a real session, tier, watcher and index: how many notes use each property,
//! which notes they are, and which of them hold a value the property's type cannot show.

use memry_desktop::notes::properties::usage::{
    PropertyNoteUsageView, PropertyUsageView, notes_with_property, property_usage,
};

use crate::index_support::{self, until};
use crate::notes_link_rewrite::{id_at, opened};

const NUMBERS: &str = "---\nproperties:\n  rating:\n    type: number\n---\n";

fn used(name: &str, note_count: u32, mismatch_count: u32) -> PropertyUsageView {
    PropertyUsageView {
        name: name.into(),
        note_count,
        mismatch_count,
    }
}

#[test]
fn each_property_counts_its_notes_and_the_values_its_type_cannot_show() {
    let (e, _, _) = opened(&[
        (".memry/properties.md", NUMBERS),
        ("Beta.md", "---\nrating: good\n---\n"),
        ("alpha.md", "---\nrating: 5\nmood: calm\n---\n"),
        ("Gamma.md", "---\nrating: 7\n---\n"),
        ("journal/2026-11-05.md", "---\nrating: 3\n---\n"),
        ("Plain.md", "No properties.\n"),
    ]);
    until("every file read", || index_support::all_indexed(&e));
    let open = e.session.current().unwrap();
    let expected = [used("mood", 1, 0), used("rating", 4, 1)];
    until("every row counted", || {
        property_usage(&open).unwrap() == expected
    });

    let notes = notes_with_property(&open, "rating").unwrap();
    let got: Vec<(&str, &str, bool)> = notes
        .iter()
        .map(|note| (note.title.as_str(), note.path.as_str(), note.mismatch))
        .collect();
    assert_eq!(
        got,
        [
            ("2026-11-05", "journal/2026-11-05.md", false),
            ("alpha", "alpha.md", false),
            ("Beta", "Beta.md", true),
            ("Gamma", "Gamma.md", false),
        ]
    );
    let beta: &PropertyNoteUsageView = &notes[2];
    assert_eq!(beta.id, id_at(&e, "Beta.md"));
    assert!(notes_with_property(&open, "missing").unwrap().is_empty());
}
