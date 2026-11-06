//! The journal folder moved outside the app (Finder), followed (Step 13m-7b-2b stage c, #3530):
//! once every day the move carried is held, owed its move, and the folder the setting names is
//! gone while the one they went to is there, the setting follows that folder
//! (`journal::folder_follow::follow_moved_journal`) at the next open, or first in a day create,
//! a settings update, a folder move or a folder delete. Each test runs on the app's own identity
//! with a day and a note whose title is a date, and ends with both in the folder the setting
//! names, no record deleted and no delete in the outbox.
//!
//! | Test                                                              | Rule                               |
//! | ----------------------------------------------------------------- | ---------------------------------- |
//! | a journal folder moved outside is followed at the next open       | open                               |
//! | a journal folder moved while closed is followed by the open after | the walk holds, the next open follows |
//! | a day made after an outside move lands in the moved folder        | day create follows first           |
//! | a settings change after an outside move takes the moved days      | settings update follows first      |
//! | a folder move after an outside move takes the journal along       | folder move follows first          |
//! | a folder delete after an outside move is refused as the journal's | folder delete follows first        |
//! | a follow cut short after its save settles at the next open        | crash between save and settle      |
//! | an outside move waits for readable settings                      | unread: held, then followed        |
//! | a folder moved while closed and unread keeps its dated note       | followed moves keep what they were |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::config_path;
use vault_env::{Env, QUIET, indexed};

use crate::journal_change::folder;
use crate::journal_folder::{
    DAY, crossed, daily, dated_note, make_day, outbox, quiet, reopen, row, settles,
};
use crate::vault_settings::{opened_keeping, stored, update};

/// A vault with a day and a dated note in `journal/`, open.
fn journal() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>, String) {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    (e, notes, store, note)
}

/// `journal` renamed to `to` outside the app while it runs: the watcher holds the day, owed its
/// move, and makes and removes no note.
fn moved_outside(e: &mut Env, to: &str) {
    fs::rename(e.vault.join("journal"), e.vault.join(to)).unwrap();
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
    assert!(e.rows().contains(&row(DAY, &format!("{to}/2025-01-02.md"))));
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
}

#[test]
fn a_journal_folder_moved_outside_is_followed_at_the_next_open() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    reopen(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// Moved while the app is closed, the open's walk holds the day; the open after it follows.
#[test]
fn a_journal_folder_moved_while_closed_is_followed_by_the_open_after() {
    let (mut e, notes, _, note) = journal();
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    reopen(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// A day made in the session of the move follows the folder first, so it lands beside the other
/// days instead of in a new folder under the old name.
#[test]
fn a_day_made_after_an_outside_move_lands_in_the_moved_folder() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("Diary/2025-01-07.md").exists());
    assert!(!e.vault.join("journal").exists());
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}

/// A journal folder change in the session of the move follows the folder first and moves the
/// days from there. Saved over the held days, the next open would cross each into a note: the
/// day deleted, and the delete synced.
#[test]
fn a_settings_change_after_an_outside_move_takes_the_moved_days() {
    let (mut e, _, _, note) = journal();
    moved_outside(&mut e, "Diary");
    update(&e, folder("Other"), |_| {}).unwrap();
    assert!(e.vault.join("Other/2025-01-02.md").exists());
    std::thread::sleep(QUIET);
    e.drain();
    reopen(&mut e);
    assert!(e.rows().contains(&row(DAY, "Other/2025-01-02.md")));
    assert!(!outbox(&e, DAY).contains(&"delete".to_owned()));
    assert!(e.rows().iter().any(|(id, _)| *id == note));
    assert_eq!(stored(&e.vault)["journalFolder"], "Other");
}

/// The moved folder moved again in the app: the setting follows the outside move first, so the
/// app's move carries the journal and its setting along.
#[test]
fn a_folder_move_after_an_outside_move_takes_the_journal_along() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    let open = e.session.current().unwrap();
    notes
        .rename_folder(&open, "Diary", "Archive", |_| {})
        .unwrap();
    drop(open);
    assert_eq!(stored(&e.vault)["journalFolder"], "Archive");
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Archive");
}

/// The moved folder deleted in the app: the setting follows first, so the folder is refused as
/// the one that holds the journal instead of taking the days with it.
#[test]
fn a_folder_delete_after_an_outside_move_is_refused_as_the_journals() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    let open = e.session.current().unwrap();
    let deleted = notes.delete_folder(&open, "Diary");
    assert!(
        matches!(deleted, Err(NotesError::FolderHoldsJournal)),
        "{deleted:?}"
    );
    drop(open);
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    settles(&mut e, &notes, &note, "Diary");
}

/// Stopped after the followed folder was saved and before the moves owed settled, as a crash
/// there stops it: the next open settles each day's move by the saved setting.
#[test]
fn a_follow_cut_short_after_its_save_settles_at_the_next_open() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    e.close();
    fs::write(config_path(&e.vault), daily("Diary").to_string()).unwrap();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    settles(&mut e, &notes, &note, "Diary");
}

/// The next open cannot read the settings: nothing follows and the day stays held. Once they
/// read again, the next day made follows first and lands beside the moved day.
#[test]
fn an_outside_move_waits_for_readable_settings() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "Diary");
    e.close();
    fs::write(config_path(&e.vault), "{").unwrap();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    assert!(e.rows().contains(&row(DAY, "Diary/2025-01-02.md")));
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("Diary/2025-01-07.md").exists());
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}

/// Moved while the app is closed, and that open cannot read the settings: its walk pairs every
/// moved file as a move owed, the dated note's too. The follow settles them by the setting
/// before and after, so the note a date names stays that note; settled by the new setting
/// alone, it would be crossed into a day and the note deleted.
#[test]
fn a_folder_moved_while_closed_and_unread_keeps_its_dated_note() {
    let (mut e, notes, _, note) = journal();
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    fs::write(config_path(&e.vault), "{").unwrap();
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(&mut e);
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    make_day(&notes, &e, "2025-01-07");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}
