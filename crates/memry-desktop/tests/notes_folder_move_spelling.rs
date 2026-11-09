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
//! | the sidebar's rename in a parent spelled otherwise lands there    | the disk's parent           |
//! | a file note in a folder named in another Unicode form follows it  | the disk's spelling         |
//! | a folder held open and named otherwise moves entry by entry       | the echo record's spelling  |
//! | a name two folders spell in case only renames neither             | case-sensitive volumes only |

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::notes::error::NotesError;
use memry_desktop::vault::consumer::{Applied, MoveKind};
use memry_desktop::vault::move_dir::{Step, simulated_hold};
use memry_desktop::vault::trash::move_to_trash;

use crate::notes_folder_move::{
    MID_MOVE, Work, activity_is_empty, file_note, live_folder_records, note, opened_with,
    row_facts, rows, slots, work_with,
};

fn renamed(id: &str, old: &str, new: &str) -> Applied {
    Applied::Renamed {
        note_id: id.to_owned(),
        old_path: old.to_owned(),
        new_path: new.to_owned(),
        kind: MoveKind::Moved,
    }
}

fn sorted<T: std::fmt::Debug>(mut items: Vec<T>) -> Vec<T> {
    items.sort_by_key(|item| format!("{item:?}"));
    items
}

/// The names in `dir` of the vault that fold to `name`.
fn spelled(e: &vault_env::Env, dir: &str, name: &str) -> Vec<String> {
    fs::read_dir(e.vault.join(dir))
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
    assert!(spelled(&e, "", "work").is_empty());
    assert_eq!(e.read("Projects/Plan.md"), bytes);
    assert_eq!(
        rows(&e),
        sorted(vec![
            (plan.clone(), "Projects/Plan.md".to_owned()),
            (deep.clone(), "Projects/Sub/Deep.md".to_owned()),
            (doc.clone(), "Projects/Doc.pdf".to_owned()),
        ])
    );
    assert_eq!(
        live_folder_records(&e),
        [("Projects".to_owned(), Some("lucide:book".to_owned()))]
    );
    assert_eq!(
        slots(&e),
        [
            ("Projects/Plan.md".to_owned(), "Projects".to_owned(), 1),
            ("Projects/Sub".to_owned(), "Projects".to_owned(), 0),
        ]
    );
    assert_eq!(
        facts,
        sorted(vec![
            renamed(&plan, "Work/Plan.md", "Projects/Plan.md"),
            renamed(&deep, "Work/Sub/Deep.md", "Projects/Sub/Deep.md"),
            renamed(&doc, "Work/Doc.pdf", "Projects/Doc.pdf"),
        ])
    );
    activity_is_empty(&e);
}

/// `rename_folder("ARCHIVE", "archive")` with `Archive` on disk respells it as asked.
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
    assert_eq!(spelled(&e, "", "archive"), ["archive"]);
    assert_eq!(rows(&e), [(old.clone(), "archive/Old.md".to_owned())]);
    assert_eq!(facts, [renamed(&old, "Archive/Old.md", "archive/Old.md")]);
    activity_is_empty(&e);
}

/// The sidebar builds the new path from the old one's parent (`use-note-tree-actions.ts`), so a
/// stale `WORK/Sub` is renamed to `WORK/Done`: it lands in `Work`, the parent the disk lists,
/// and makes no second spelling of it.
#[test]
fn the_sidebars_rename_in_a_parent_spelled_otherwise_lands_there() {
    let (mut e, notes, _) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    let old = notes.create(&open, note("Old", "Work/Sub")).unwrap().id;
    e.drain();

    notes
        .rename_folder(&open, "WORK/Sub", "WORK/Done", |_| {})
        .unwrap();

    let facts = row_facts(&mut e);
    assert_eq!(spelled(&e, "", "work"), ["Work"]);
    assert_eq!(spelled(&e, "Work", "done"), ["Done"]);
    assert!(spelled(&e, "Work", "sub").is_empty());
    assert_eq!(rows(&e), [(old.clone(), "Work/Done/Old.md".to_owned())]);
    assert_eq!(
        facts,
        [renamed(&old, "Work/Sub/Old.md", "Work/Done/Old.md")]
    );
    activity_is_empty(&e);
}

/// A PDF, whose row has no hash the watcher could pair a moved file on, in a folder the disk
/// spells decomposed (`Cafe\u{301}`) and the caller composed: it follows the folder as itself.
#[test]
fn a_file_note_in_a_folder_named_in_another_unicode_form_follows_it() {
    let (mut e, notes, store) = opened_with(move_to_trash);
    fs::create_dir(e.vault.join("Cafe\u{301}")).unwrap();
    let doc = file_note(&mut e, &store, "Cafe\u{301}/Doc.pdf");
    let open = e.session.current().unwrap();

    notes
        .rename_folder(&open, "Caf\u{e9}", "Done", |_| {})
        .unwrap();

    let facts = row_facts(&mut e);
    assert_eq!(e.read("Done/Doc.pdf"), "%PDF-1.4 bytes");
    assert_eq!(rows(&e), [(doc.clone(), "Done/Doc.pdf".to_owned())]);
    assert_eq!(
        facts,
        [renamed(&doc, "Cafe\u{301}/Doc.pdf", "Done/Doc.pdf")]
    );
    activity_is_empty(&e);
}

/// `a_folder_held_open_moves_entry_by_entry_its_subfolder_with_it` named `WORK`: the record that
/// keeps the watcher from taking the entry-wise move for deletes names the disk's `Work`.
#[test]
fn a_folder_held_open_and_named_otherwise_moves_entry_by_entry() {
    let Work {
        mut e,
        notes,
        plan,
        deep,
        doc,
        ..
    } = work_with(move_to_trash);
    let open = e.session.current().unwrap();
    notes.create_folder(&open, "Archive").unwrap();
    e.drain();
    let mut entries = 0;
    let mut held = |step: Step<'_>| match step {
        Step::Whole { .. } => Err(simulated_hold()),
        Step::Entry { .. } => {
            entries += 1;
            if entries == 3 {
                std::thread::sleep(MID_MOVE);
            }
            Ok(())
        }
        _ => Ok(()),
    };
    notes
        .rename_folder_checked(
            &open,
            "WORK",
            "Archive/Work",
            |_| {},
            &mut held,
            &mut || Ok(()),
        )
        .unwrap();

    let facts = row_facts(&mut e);
    assert!(spelled(&e, "", "work").is_empty());
    assert!(e.vault.join("Archive/Work/Sub/Deep.md").exists());
    assert_eq!(
        rows(&e),
        sorted(vec![
            (plan.clone(), "Archive/Work/Plan.md".to_owned()),
            (deep.clone(), "Archive/Work/Sub/Deep.md".to_owned()),
            (doc.clone(), "Archive/Work/Doc.pdf".to_owned()),
        ])
    );
    assert_eq!(
        facts,
        sorted(vec![
            renamed(&plan, "Work/Plan.md", "Archive/Work/Plan.md"),
            renamed(&deep, "Work/Sub/Deep.md", "Archive/Work/Sub/Deep.md"),
            renamed(&doc, "Work/Doc.pdf", "Archive/Work/Doc.pdf"),
        ])
    );
    activity_is_empty(&e);
}

/// A case-sensitive volume (Linux) holds `WORK` and `work` as two folders, and `Work` names
/// neither: refused, both left as they are. A case-blind volume cannot hold the two, so the
/// test has nothing to set up there; the choice itself is unit-tested in `notes::folders`.
#[test]
fn a_name_two_folders_spell_in_case_only_renames_neither() {
    let (e, notes, _) = opened_with(move_to_trash);
    let open = e.session.current().unwrap();
    fs::create_dir(e.vault.join("WORK")).unwrap();
    if e.vault.join("work").exists() {
        eprintln!("a case-blind volume holds one `work` folder: nothing to refuse");
        return;
    }
    fs::create_dir(e.vault.join("work")).unwrap();
    fs::write(e.vault.join("WORK/Upper.md"), "upper\n").unwrap();
    fs::write(e.vault.join("work/Lower.md"), "lower\n").unwrap();

    let refused = notes.rename_folder(&open, "Work", "Projects", |_| {});

    assert!(
        matches!(refused, Err(NotesError::FolderNotFound)),
        "{refused:?}"
    );
    assert!(e.vault.join("WORK/Upper.md").exists());
    assert!(e.vault.join("work/Lower.md").exists());
    assert!(!e.vault.join("Projects").exists());
}
