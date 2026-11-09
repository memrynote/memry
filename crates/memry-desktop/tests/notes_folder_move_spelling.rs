//! A folder rename named in another spelling than the disk's (#4077): the sidebar or a caller
//! says `ARCHIVE` for the folder the disk lists as `Archive`. A case-blind disk (macOS, Windows)
//! moves `Archive` for it, so the rows, which name `Archive/`, must follow the disk's spelling:
//! a row left at `Archive/Old.md` is a note lost, and the file the watcher then finds at
//! `Attic/Old.md` a new note with a new id, synced as a create.
//!
//! | Test                                                              | Rule                        |
//! | ----------------------------------------------------------------- | --------------------------- |
//! | another spelling of a folder renames it with its notes            | the disk's spelling         |
//! | a case-only rename named in another spelling carries its notes    | the disk's spelling         |
//! | another spelling of a parent folder renames the folder below it   | the disk's spelling         |

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::vault::consumer::{Applied, MoveKind};

use crate::notes_folder_move::{
    Work, activity_is_empty, note, opened_with, row_facts, rows, work_with,
};
use memry_desktop::vault::trash::move_to_trash;

fn renamed(id: &str, old: &str, new: &str) -> Applied {
    Applied::Renamed {
        note_id: id.to_owned(),
        old_path: old.to_owned(),
        new_path: new.to_owned(),
        kind: MoveKind::Moved,
    }
}

/// The names in the vault root that fold to `name`.
fn spelled(e: &vault_env::Env, name: &str) -> Vec<String> {
    fs::read_dir(&e.vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|entry| entry.eq_ignore_ascii_case(name))
        .collect()
}

/// `Work` holds `Plan.md`, `Sub/Deep.md` and a PDF, whose row has no hash a watcher could pair
/// the moved file on: a row the move leaves behind comes back as a new note.
#[test]
fn another_spelling_of_a_folder_renames_it_with_its_notes() {
    let Work {
        mut e,
        notes,
        plan,
        deep,
        doc,
        ..
    } = work_with(move_to_trash);
    let open = e.session.current().unwrap();
    let bytes = e.read("Work/Plan.md");

    notes
        .rename_folder(&open, "WORK", "Projects", |_| {})
        .unwrap();

    // Once the watcher went quiet: a row left behind, or a note it added, shows here.
    let facts = row_facts(&mut e);
    assert!(spelled(&e, "work").is_empty());
    assert_eq!(e.read("Projects/Plan.md"), bytes);
    let mut expected = vec![
        (plan.clone(), "Projects/Plan.md".to_owned()),
        (deep.clone(), "Projects/Sub/Deep.md".to_owned()),
        (doc.clone(), "Projects/Doc.pdf".to_owned()),
    ];
    expected.sort();
    assert_eq!(rows(&e), expected);
    let mut expected = vec![
        renamed(&plan, "Work/Plan.md", "Projects/Plan.md"),
        renamed(&deep, "Work/Sub/Deep.md", "Projects/Sub/Deep.md"),
        renamed(&doc, "Work/Doc.pdf", "Projects/Doc.pdf"),
    ];
    expected.sort_by_key(|fact| format!("{fact:?}"));
    assert_eq!(facts, expected);
    activity_is_empty(&e);
}

#[test]
fn a_case_only_rename_named_in_another_spelling_carries_its_notes() {
    let (mut e, notes, _) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    let old = notes.create(&open, note("Old", "Archive")).unwrap().id;
    e.drain();

    notes
        .rename_folder(&open, "ARCHIVE", "archive", |_| {})
        .unwrap();

    let facts = row_facts(&mut e);
    assert_eq!(spelled(&e, "archive"), ["archive"]);
    assert_eq!(rows(&e), [(old.clone(), "archive/Old.md".to_owned())]);
    assert_eq!(facts, [renamed(&old, "Archive/Old.md", "archive/Old.md")]);
    activity_is_empty(&e);
}

#[test]
fn another_spelling_of_a_parent_folder_renames_the_folder_below_it() {
    let (mut e, notes, _) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    let old = notes.create(&open, note("Old", "Work/Sub")).unwrap().id;
    e.drain();

    notes
        .rename_folder(&open, "WORK/Sub", "Work/Done", |_| {})
        .unwrap();

    let facts = row_facts(&mut e);
    assert!(!e.vault.join("Work/Sub").exists());
    assert_eq!(rows(&e), [(old.clone(), "Work/Done/Old.md".to_owned())]);
    assert_eq!(
        facts,
        [renamed(&old, "Work/Sub/Old.md", "Work/Done/Old.md")]
    );
    activity_is_empty(&e);
}
