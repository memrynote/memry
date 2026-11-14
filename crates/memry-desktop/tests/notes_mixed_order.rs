//! The sidebar's mixed manual order (#4412, Electron `437a9da8b1`): a level ordered with
//! folders and notes interleaved is saved by one `notes:reorder` whose paths hold both, plus
//! the `<folder>/` marker row (`/` at the root) that tells the tree to draw the level as one
//! list. Ports the `mixed-order marker row` block of Electron's `note-positions.test.ts`
//! through the real vault tier.
//!
//! | Test                                                        | Rule                         |
//! | ----------------------------------------------------------- | ---------------------------- |
//! | a mixed root order reads back in order after a reopen       | `reorderNotesInFolder`       |
//! | the marker row follows its folder through a rename          | `carryFolderPositions`       |
//! | the marker row goes away with its folder                    | `dropFolderPositions`        |
//! | a new note still opens at the top of a mixed level          | `placeNewItemAtTop`          |

use memry_desktop::notes::positions;
use memry_desktop::vault::trash::move_to_trash;

use crate::notes_folder_move::{note, opened_with, slots};

/// Paths in slot order, as the tree reads them.
fn order(all: std::collections::BTreeMap<String, i64>) -> Vec<String> {
    let mut rows: Vec<(String, i64)> = all.into_iter().collect();
    rows.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    rows.into_iter().map(|(path, _)| path).collect()
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn a_mixed_root_order_reads_back_in_order_after_a_reopen() {
    let (mut e, notes, _store) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "A").unwrap();
    notes.create_folder(&open, "B").unwrap();
    notes.create(&open, note("a", "")).unwrap();
    let mixed = paths(&["/", "B", "a.md", "A"]);

    positions::reorder(&open, "", mixed.clone()).unwrap();
    assert_eq!(order(positions::all(&open).unwrap()), mixed);
    drop(open);

    e.close();
    e.open();
    let open = e.session.current().unwrap();
    assert_eq!(order(positions::all(&open).unwrap()), mixed);
}

/// `Work` holds `a.md`, `Sub/` and `b.md`, ordered as one list.
fn mixed_work() -> (
    crate::vault_env::Env,
    std::sync::Arc<memry_desktop::notes::service::NotesService>,
) {
    let (e, notes, _store) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Work/Sub").unwrap();
    notes.create(&open, note("a", "Work")).unwrap();
    notes.create(&open, note("b", "Work")).unwrap();
    positions::reorder(
        &open,
        "Work",
        paths(&["Work/", "Work/a.md", "Work/Sub", "Work/b.md"]),
    )
    .unwrap();
    (e, notes)
}

#[test]
fn the_marker_row_follows_its_folder_through_a_rename() {
    let (e, notes) = mixed_work();
    let open = e.session.current().unwrap();

    notes.rename_folder(&open, "Work", "Projects", |_| {}).unwrap();

    let in_level = |level: &str| -> Vec<String> {
        let mut rows: Vec<(String, String, i64)> = slots(&e)
            .into_iter()
            .filter(|(_, folder, _)| folder == level)
            .collect();
        rows.sort_by_key(|row| row.2);
        rows.into_iter().map(|(path, _, _)| path).collect()
    };
    assert_eq!(
        in_level("Projects"),
        paths(&["Projects/", "Projects/a.md", "Projects/Sub", "Projects/b.md"])
    );
    assert_eq!(in_level("Work"), Vec::<String>::new());
}

#[test]
fn the_marker_row_goes_away_with_its_folder() {
    let (e, notes) = mixed_work();
    let open = e.session.current().unwrap();

    notes.delete_folder(&open, "Work").unwrap();

    assert_eq!(positions::all(&open).unwrap(), Default::default());
}

#[test]
fn a_new_note_still_opens_at_the_top_of_a_mixed_level() {
    let (e, notes) = mixed_work();
    let open = e.session.current().unwrap();

    notes.create(&open, note("new", "Work")).unwrap();

    let first = slots(&e)
        .into_iter()
        .filter(|(_, folder, _)| folder == "Work")
        .min_by_key(|row| row.2)
        .map(|(path, _, _)| path);
    assert_eq!(first.as_deref(), Some("Work/new.md"));
}
