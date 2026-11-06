//! The claim of an app move the core still records (Step 13m-7b-2b, #3530): until the open that
//! finishes it, the move's note owns both its old path and its new one (`notes::identity`'s
//! `moving`). The watcher's rescans and an open that cannot read the settings meet the state
//! such a move leaves, the rows at the old paths and the files at the new ones; neither may take
//! a file for a new note, or an old row's absence for a removal or a crossing. A pass ends with
//! no record deleted and no `delete` queued, through a day made later and two more opens.
//!
//! | Test                                                               | State                     |
//! | ------------------------------------------------------------------ | ------------------------- |
//! | a journal folder that stays moved keeps its notes through a rescan | live, OS rescan or resync |
//! | a plain folder that stays moved keeps its notes through a rescan   | live, plain folder        |
//! | a note deleted while its folder move waits is deleted              | live, then a delete       |
//! | a folder move a crash cut short keeps its edited notes unread      | crash, plain folder       |
//! | a folder move whose old name a file took waits with its notes      | crash, the open's walk    |
//! | a journal folder move a crash cut short keeps its edited notes ... | crash, journal            |
//! | a journal folder that stays moved keeps an edited note unread      | live, then an unread open |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use memry_core::domain::notes::app_move::AppMoved;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::move_dir::{Step, simulated_hold};
use vault_env::{Env, indexed};

use crate::journal_folder::{
    DAY, crashed_after_disk, crossed, daily, dated_note, journal_vault, outbox, quiet, reopen, row,
    settles,
};
use crate::vault_settings::{opened_keeping, stored};

/// How long a rescan takes to report what it found, past the watcher's quiet time.
const RESCAN: Duration = Duration::from_secs(2);

/// The watcher looks at the disk again in the session, and reports no new note and no removal.
fn rescanned(e: &mut Env, forget: bool) {
    e.tier.rescan_watcher(forget);
    std::thread::sleep(RESCAN);
    quiet(e);
}

/// The closed vault opened while the settings cannot be read, then readable settings again
/// (`config`).
fn opened_unread(e: &mut Env, config: &str) {
    fs::write(config_path(&e.vault), "{").unwrap();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(e);
    fs::write(config_path(&e.vault), daily(config).to_string()).unwrap();
}

/// Step 3 of the journal folder's move fails and the folder cannot go back (Windows holds it):
/// it stays at `Diary`, its rows at `journal`, its records pending.
fn stays_moved(notes: &NotesService, e: &mut Env) {
    let open = e.session.current().unwrap();
    let mut wholes = 0;
    let mut second_held = |step: Step<'_>| match step {
        Step::Whole { .. } => {
            wholes += 1;
            if wholes == 2 {
                Err(simulated_hold())
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    };
    let failed = notes.rename_folder_checked(
        &open,
        "journal",
        "Diary",
        |_| {},
        &mut second_held,
        &mut || Err(NotesError::Io(io::Error::other("injected"))),
    );
    assert!(failed.is_err(), "{failed:?}");
    assert!(e.vault.join("Diary/2025-01-05.md").exists());
    quiet(e);
}

/// N2: the OS asks for a rescan (`need_rescan`), or the consumer dropped events (a resync, which
/// forgets what was reported), while the journal folder stays moved, the dated note edited or
/// not. Unclaimed, each old row's absence deleted its record, or paired with its moved file and
/// crossed under the followed setting.
#[test]
fn a_journal_folder_that_stays_moved_keeps_its_notes_through_a_rescan() {
    for (forget, edit) in [(false, false), (true, false), (true, true)] {
        let (mut e, notes) =
            journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let note = dated_note(&notes, &mut e);
        stays_moved(&notes, &mut e);
        if edit {
            e.write("Diary/2025-01-05.md", "Edited outside\n");
            quiet(&mut e);
        }
        rescanned(&mut e, forget);
        assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
        settles(&mut e, &notes, &note, "Diary");
        if edit {
            assert!(
                e.body(&note).contains("Edited outside"),
                "{}",
                e.body(&note)
            );
        }
    }
}

/// N2p: the same for a plain folder, whose move back fails because a file took its old name.
#[test]
fn a_plain_folder_that_stays_moved_keeps_its_notes_through_a_rescan() {
    let (mut e, notes) = journal_vault(
        daily("journal"),
        &[("Notes/A.md", "Note A\n"), ("Notes/B.md", "Note B\n")],
    );
    let ids = plain_stays_moved(&notes, &mut e);
    rescanned(&mut e, false);
    fs::remove_file(e.vault.join("Notes")).unwrap();
    reopen(&mut e);
    reopen(&mut e);
    kept(&e, &ids);
}

/// The same, and the user deletes a moved note's file while the move waits: once the move is
/// settled, that delete is the note's, as any delete outside the app is.
#[test]
fn a_note_deleted_while_its_folder_move_waits_is_deleted() {
    let (mut e, notes) = journal_vault(
        daily("journal"),
        &[("Notes/A.md", "Note A\n"), ("Notes/B.md", "Note B\n")],
    );
    let ids = plain_stays_moved(&notes, &mut e);
    rescanned(&mut e, false);
    fs::remove_file(e.vault.join("Other/A.md")).unwrap();
    std::thread::sleep(RESCAN);
    e.drain();
    fs::remove_file(e.vault.join("Notes")).unwrap();
    let mut facts = Vec::new();
    for _ in 0..3 {
        e.close();
        e.drain();
        e.open();
        facts.extend(e.facts_until(indexed));
        std::thread::sleep(RESCAN);
        facts.extend(e.drain());
    }
    let removed = |id: &str| {
        facts
            .iter()
            .any(|f| matches!(f, Applied::Removed { note_id, .. } if note_id == id))
    };
    assert!(removed(&ids[0]), "{facts:?}");
    assert!(outbox(&e, &ids[0]).contains(&"delete".to_owned()));
    assert!(!removed(&ids[1]), "{facts:?}");
    assert_eq!(e.rows(), [row(&ids[1], "Other/B.md")]);
}

/// Step 3 of `Notes`' move to `Other` fails and the folder cannot go back, a file having taken
/// its old name; the ids of `A.md` and `B.md`.
fn plain_stays_moved(notes: &NotesService, e: &mut Env) -> Vec<String> {
    let ids: Vec<String> = e.rows().into_iter().map(|(id, _)| id).collect();
    let open = e.session.current().unwrap();
    let vault = e.vault.clone();
    let failed = notes.rename_folder_checked(
        &open,
        "Notes",
        "Other",
        |_| panic!("announced"),
        &mut |_| Ok(()),
        &mut || {
            fs::write(vault.join("Notes"), "A file took the name").unwrap();
            Err(NotesError::Io(io::Error::other("injected")))
        },
    );
    drop(open);
    assert!(failed.is_err(), "{failed:?}");
    assert!(e.vault.join("Other/A.md").exists());
    quiet(e);
    ids
}

/// N1a: a plain folder's move cut short after the disk move, a moved note edited outside, and
/// the next open cannot read the settings, so the folder's records wait. The edited file cannot
/// pair with its old row by its bytes: unclaimed, the row's absence deleted the note.
#[test]
fn a_folder_move_a_crash_cut_short_keeps_its_edited_notes_while_the_settings_are_unread() {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[("Notes/A.md", "Note A\n"), ("Notes/B.md", "Note B\n")],
    );
    let ids = crashed_plain(&mut e, &store);
    fs::write(e.vault.join("Other/A.md"), "Note A, edited outside\n").unwrap();

    opened_unread(&mut e, "journal");
    reopen(&mut e);
    reopen(&mut e);
    kept(&e, &ids);
    // The edit reaches the note's body, which syncs, once the move finishes.
    assert!(
        e.body(&ids[0]).contains("edited outside"),
        "{}",
        e.body(&ids[0])
    );
}

/// The state a crash after `Notes` moved to `Other` on disk leaves, before its notes followed;
/// the ids of `A.md` and `B.md`.
fn crashed_plain(e: &mut Env, store: &Arc<dyn SecureStore>) -> Vec<String> {
    let ids: Vec<String> = e.rows().into_iter().map(|(id, _)| id).collect();
    let writer = e.core().notes_writer(store.clone()).unwrap();
    let moved = |old_path, new_path| AppMoved {
        old_path,
        new_path,
        title: None,
        keeps_kind: true,
    };
    let moves = [
        (ids[0].as_str(), moved("Notes/A.md", "Other/A.md")),
        (ids[1].as_str(), moved("Notes/B.md", "Other/B.md")),
    ];
    writer.begin_folder_move("Notes", "Other", &moves).unwrap();
    drop(writer);
    e.close();
    fs::rename(e.vault.join("Notes"), e.vault.join("Other")).unwrap();
    e.drain();
    ids
}

/// `A.md` and `B.md` are their notes' at `Other`, and no delete was queued for either.
fn kept(e: &Env, ids: &[String]) {
    let rows = e.rows();
    for (id, name) in ids.iter().zip(["A.md", "B.md"]) {
        assert!(
            rows.contains(&row(id, &format!("Other/{name}"))),
            "{rows:?}"
        );
        assert!(!outbox(e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// A folder move cut short after the disk move, and a file took the folder's old name before
/// the next open: the open cannot tell whether the notes left it (the old paths cannot be
/// listed), so the records wait, and the open's walk finds the moved files with no row. They are
/// the waiting notes', not new ones, until the file goes and an open finishes the move.
#[test]
fn a_folder_move_whose_old_name_a_file_took_waits_with_its_notes() {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[("Notes/A.md", "Note A\n"), ("Notes/B.md", "Note B\n")],
    );
    let ids = crashed_plain(&mut e, &store);
    fs::write(e.vault.join("Notes"), "A file took the name").unwrap();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    fs::remove_file(e.vault.join("Notes")).unwrap();
    reopen(&mut e);
    reopen(&mut e);
    kept(&e, &ids);
}

/// N1b: the journal folder's move cut short after the disk move, the setting saved or not, the
/// day and the dated note edited outside, and the next open cannot read the settings.
#[test]
fn a_journal_folder_move_a_crash_cut_short_keeps_its_edited_notes_while_the_settings_are_unread() {
    for config in ["journal", "Diary"] {
        let (mut e, store) =
            opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
        let notes = NotesService::new(e.tier.clone(), store.clone());
        let note = dated_note(&notes, &mut e);
        crashed_after_disk(&mut e, &store, &note, config);
        fs::write(e.vault.join("Diary/2025-01-05.md"), "Note edited outside\n").unwrap();
        fs::write(e.vault.join("Diary/2025-01-02.md"), "Day edited outside\n").unwrap();

        opened_unread(&mut e, config);
        settles(&mut e, &notes, &note, "Diary");
        assert!(e.body(&note).contains("Note edited outside"), "{config}");
        assert!(e.body(DAY).contains("Day edited outside"), "{config}");
    }
}

/// N1c: the journal folder stays moved, the dated note is edited outside in the session, and
/// the next open cannot read the settings.
#[test]
fn a_journal_folder_that_stays_moved_keeps_an_edited_note_while_the_settings_are_unread() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let note = dated_note(&notes, &mut e);
    stays_moved(&notes, &mut e);
    e.write("Diary/2025-01-05.md", "Edited outside\n");
    quiet(&mut e);
    e.close();
    e.drain();

    opened_unread(&mut e, "Diary");
    settles(&mut e, &notes, &note, "Diary");
    assert!(
        e.body(&note).contains("Edited outside"),
        "{}",
        e.body(&note)
    );
}
