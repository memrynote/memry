//! A folder deleted in the app (Step 13h, #3530) under the running vault tier: recorded, the
//! folder to the trash whole, then every note, row, folder record and the order in one step, one
//! `Removed` fact per note, and the watcher reporting none of it back.
//!
//! | Test                                                          | Rule                                 |
//! | ------------------------------------------------------------- | ------------------------------------ |
//! | a folder delete trashes it and deletes its notes and records  | `deleteFolderCommand`                |
//! | a folder the trash refuses stays whole                        | 13f's trash refusal                  |
//! | a folder delete a crash cut short finishes on the next open   | the folder's record                  |
//! | a folder delete a crash cut short before the trash is forgotten | the folder's record                |
//! | a folder delete the app cannot make is refused                | missing, journal, hidden, link, case |
//! | a folder the trash takes only part of is reported as such     | the watcher reports what went        |

#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;

use memry_desktop::notes::error::NotesError;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use vault_env::indexed;

use crate::notes_folder_move::{
    MID_MOVE, Work, activity_is_empty, armed, live_folder_records, outside_note, removed_ids,
    row_facts, rows, slots, work_with,
};

/// The test's trash: the folder moves out of the vault, beside it, as `trash-<name>`.
fn bin(path: &Path) -> Result<(), String> {
    let vault = path
        .ancestors()
        .find(|at| at.file_name().is_some_and(|name| name == "vault"))
        .ok_or("not in the vault")?;
    let name = path.file_name().ok_or("no name")?.to_string_lossy();
    let to = vault
        .parent()
        .ok_or("no parent")?
        .join(format!("trash-{name}"));
    fs::rename(path, to).map_err(|error| error.to_string())
}

fn no_bin(_: &Path) -> Result<(), String> {
    Err("no bin".to_owned())
}

fn pending_deletes(e: &vault_env::Env, store: &Arc<dyn SecureStore>) -> usize {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.pending_folder_deletes().unwrap().len()
}

fn removed(id: &str, path: &str) -> Applied {
    Applied::Removed {
        note_id: id.to_owned(),
        path: path.to_owned(),
        source: ChangeSource::App,
    }
}

#[test]
fn a_folder_delete_trashes_it_and_deletes_its_notes_and_records() {
    let Work {
        mut e,
        notes,
        store,
        plan,
        deep,
        doc,
    } = work_with(bin);
    let open = e.session.current().unwrap();
    // Once the folder is in the trash, before its notes go, the watcher looks.
    notes
        .delete_folder_checked(&open, "Work", &mut || {
            std::thread::sleep(MID_MOVE);
            Ok(())
        })
        .unwrap();

    assert!(!e.vault.join("Work").exists());
    let trashed = e.vault.parent().unwrap().join("trash-Work");
    assert!(trashed.join("Sub/Deep.md").exists());
    assert!(
        trashed.join(".folder.md").exists(),
        "the folder's file went with it"
    );
    assert_eq!(rows(&e), []);
    assert_eq!(live_folder_records(&e), []);
    assert_eq!(slots(&e), []);
    assert_eq!(pending_deletes(&e, &store), 0);
    let mut expected = vec![
        removed(&plan, "Work/Plan.md"),
        removed(&deep, "Work/Sub/Deep.md"),
        removed(&doc, "Work/Doc.pdf"),
    ];
    expected.sort_by_key(|fact| format!("{fact:?}"));
    assert_eq!(row_facts(&mut e), expected);
    activity_is_empty(&e);
}

/// The trash refuses: the folder, its notes and its records stay, and a delete made outside the
/// app afterwards is reported, so no record of the folder's going is left behind.
#[test]
fn a_folder_the_trash_refuses_stays_whole() {
    let Work {
        mut e,
        notes,
        store,
        ..
    } = work_with(no_bin);
    let open = e.session.current().unwrap();
    let before = rows(&e);
    let refused = notes.delete_folder(&open, "Work");
    assert!(
        matches!(refused, Err(NotesError::TrashUnavailable(_))),
        "{refused:?}"
    );
    assert!(e.vault.join("Work/Sub/Deep.md").exists());
    assert_eq!(rows(&e), before);
    assert_eq!(live_folder_records(&e)[0].0, "Work");
    assert_eq!(pending_deletes(&e, &store), 0);
    e.drain();

    let later = outside_note(&mut e);
    fs::remove_file(e.vault.join("Work/Outside.md")).unwrap();
    let facts =
        e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == later));
    assert_eq!(removed_ids(&facts), [later]);
}

#[test]
fn a_folder_delete_a_crash_cut_short_finishes_on_the_next_open() {
    let Work {
        mut e,
        notes,
        store,
        ..
    } = work_with(bin);
    let open = e.session.current().unwrap();
    let failed = notes.delete_folder_checked(&open, "Work", &mut || {
        Err(NotesError::Io(std::io::Error::other("injected")))
    });
    assert!(matches!(failed, Err(NotesError::Io(_))), "{failed:?}");
    assert_eq!(pending_deletes(&e, &store), 1);
    drop(open);
    e.close();
    e.open();
    e.facts_until(indexed);
    armed(&mut e);

    assert_eq!(rows(&e), []);
    assert_eq!(live_folder_records(&e), []);
    assert_eq!(slots(&e), []);
    assert_eq!(pending_deletes(&e, &store), 0);
}

#[test]
fn a_folder_delete_a_crash_cut_short_before_the_trash_is_forgotten() {
    let Work { mut e, store, .. } = work_with(bin);
    let before = rows(&e);
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.begin_folder_delete("Work", &[]).unwrap();
    drop(writer);
    e.close();
    e.open();
    e.facts_until(indexed);
    armed(&mut e);

    assert_eq!(rows(&e), before);
    assert_eq!(live_folder_records(&e)[0].0, "Work");
    assert_eq!(pending_deletes(&e, &store), 0);
}

#[test]
fn a_folder_delete_the_app_cannot_make_is_refused() {
    let Work { e, notes, .. } = work_with(bin);
    let open = e.session.current().unwrap();
    let refused = |path: &str| notes.delete_folder(&open, path).unwrap_err();
    assert!(matches!(refused("Gone"), NotesError::FolderNotFound));
    assert!(matches!(refused("journal"), NotesError::FolderHoldsJournal));
    // A year folder of a nested date format holds days, which a note delete does not take.
    fs::create_dir_all(e.vault.join("journal/2025")).unwrap();
    assert!(matches!(
        refused("journal/2025"),
        NotesError::FolderInJournal
    ));
    assert!(matches!(refused(".memry"), NotesError::InvalidFolder));
    // Another spelling of `Work`: a case-blind disk would trash `Work`, whose rows name `Work/`.
    // These legs prove the spelling guard only on a case-insensitive volume (macOS, Windows),
    // and the NFD leg only on a normalization-blind one (macOS): elsewhere the other spelling
    // is simply not there, and the refusal comes from the existence check before it.
    assert!(matches!(refused("work"), NotesError::FolderNotFound));
    assert!(matches!(refused("Work/sub"), NotesError::FolderNotFound));
    fs::create_dir(e.vault.join("Caf\u{e9}")).unwrap();
    assert!(matches!(refused("Cafe\u{301}"), NotesError::FolderNotFound));
    assert!(e.vault.join("Caf\u{e9}").exists());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(e.vault.join("Work"), e.vault.join("Link")).unwrap();
        assert!(matches!(refused("Link"), NotesError::InvalidFolder));
        assert!(matches!(refused("Link/Sub"), NotesError::InvalidFolder));
    }
    assert!(e.vault.join("Work/Plan.md").exists());
    assert!(e.vault.join("journal/2025").exists());
}

/// The trash took `Plan.md` and then refused the rest: the delete fails saying part of the
/// folder went, and the watcher reports the note that went as removed.
#[test]
fn a_folder_the_trash_takes_only_part_of_is_reported_as_such() {
    fn part_bin(path: &Path) -> Result<(), String> {
        let plan = path.join("Plan.md");
        fs::rename(
            &plan,
            path.parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("trash-Plan.md"),
        )
        .map_err(|error| error.to_string())?;
        Err("the rest stayed".to_owned())
    }
    let Work {
        mut e,
        notes,
        store,
        plan,
        ..
    } = work_with(part_bin);
    let open = e.session.current().unwrap();
    let refused = notes.delete_folder(&open, "Work");
    match &refused {
        Err(NotesError::TrashUnavailable(why)) => {
            assert!(why.contains("part of the folder"), "{why}")
        }
        other => panic!("{other:?}"),
    }
    assert!(e.vault.join("Work/Sub/Deep.md").exists());
    assert_eq!(pending_deletes(&e, &store), 0);
    let facts =
        e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == plan));
    assert_eq!(removed_ids(&facts), [plan]);
}
