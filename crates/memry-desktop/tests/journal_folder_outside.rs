//! The journal folder moved outside the app (Finder), followed (Step 13m-7b-2b stage c, #3530):
//! each day the move carried is held, owed its move, and right after the consumer's batch that
//! held it the setting follows the folder the days went to
//! (`journal::folder_follow::follow_moved_journal`), as Electron's watcher follows at the move's
//! first event. The open follows too, before its walk, for days an earlier session held, and a
//! day create, a settings update, a folder move and a folder delete ask first. Each test runs
//! on the app's own identity with a day and a note whose title is a date, and ends with both in
//! the folder the setting names, no record deleted and no delete in the outbox. What waits
//! instead of following: `journal_folder_held`.
//!
//! | Test                                                              | Rule                               |
//! | ----------------------------------------------------------------- | ---------------------------------- |
//! | a journal folder moved outside is followed right after the move   | the batch that held follows        |
//! | a journal folder moved while closed is followed by that open      | after the walk's batch             |
//! | the moved folder renamed again is followed again                  | P1: in session                     |
//! | the followed folder renamed while closed is followed at the open  | P2: across opens                   |
//! | the journal folder made again after the follow keeps every day    | nothing held is left to cross      |
//! | a day made after an outside move lands in the moved folder        | day create                         |
//! | a settings change after an outside move takes the moved days      | settings update                    |
//! | a folder move after an outside move takes the journal along       | folder move                        |
//! | a folder delete after an outside move is refused as the journal's | folder delete                      |
//! | an outside move while the settings are unread is followed later   | unread: owed, then followed        |
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
pub(crate) fn journal() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>, String) {
    let (mut e, store) = opened_keeping(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    (e, notes, store, note)
}

/// `from` renamed to `to` outside the app while it runs: the watcher holds the day, makes and
/// removes no note, and the day's row follows its file.
pub(crate) fn moved_outside(e: &mut Env, from: &str, to: &str) {
    fs::rename(e.vault.join(from), e.vault.join(to)).unwrap();
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(!crossed(&facts), "{facts:?}");
    assert!(e.rows().contains(&row(DAY, &format!("{to}/2025-01-02.md"))));
}

/// Opens after a change made while the app was closed: the open makes and removes no note.
pub(crate) fn opened_after(e: &mut Env) {
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    assert!(!crossed(&facts), "{facts:?}");
    quiet(e);
}

#[test]
fn a_journal_folder_moved_outside_is_followed_right_after_the_move() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// Moved while the app is closed: the open's walk holds the day, and the follow after its batch
/// saves the folder in that same open.
#[test]
fn a_journal_folder_moved_while_closed_is_followed_by_that_open() {
    let (mut e, notes, _, note) = journal();
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    opened_after(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    settles(&mut e, &notes, &note, "Diary");
}

/// P1: the moved folder renamed again in the session (a typo fixed). The setting followed the
/// first move already, so the second is the journal moving again, followed again. Left to a
/// later follow, the second move would read as each day leaving the journal: crossed into a
/// note, the day deleted, and the delete synced.
#[test]
fn the_moved_folder_renamed_again_is_followed_again() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
    moved_outside(&mut e, "Diary", "Diary2");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary2");
    settles(&mut e, &notes, &note, "Diary2");
}

/// P2: the followed folder renamed again while the app is closed: the open's walk holds the day
/// and follows the folder again.
#[test]
fn the_followed_folder_renamed_while_closed_is_followed_at_the_open() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
    e.close();
    fs::rename(e.vault.join("Diary"), e.vault.join("Diary2")).unwrap();
    opened_after(&mut e);
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary2");
    settles(&mut e, &notes, &note, "Diary2");
}

/// The old folder made again once the setting followed (by hand, or by a day create) holds no
/// day, and leaves every moved day a day through the opens after.
#[test]
fn the_journal_folder_made_again_after_the_follow_keeps_every_day() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
    fs::create_dir(e.vault.join("journal")).unwrap();
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("Diary/2025-01-07.md").exists());
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}

#[test]
fn a_day_made_after_an_outside_move_lands_in_the_moved_folder() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("Diary/2025-01-07.md").exists());
    assert!(!e.vault.join("journal").exists());
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}

/// A journal folder change after the move moves the days from the folder they are in.
#[test]
fn a_settings_change_after_an_outside_move_takes_the_moved_days() {
    let (mut e, _, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
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

/// The moved folder moved again in the app carries the journal and its setting along.
#[test]
fn a_folder_move_after_an_outside_move_takes_the_journal_along() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
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

/// The moved folder deleted in the app is refused as the one that holds the journal.
#[test]
fn a_folder_delete_after_an_outside_move_is_refused_as_the_journals() {
    let (mut e, notes, _, note) = journal();
    moved_outside(&mut e, "journal", "Diary");
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

/// Moved while the settings cannot be read: the day is owed its move as one while the journal
/// is unknown, and the batch follows nothing. Once they read again, the next day made follows
/// first and lands beside the moved day.
#[test]
fn an_outside_move_while_the_settings_are_unread_is_followed_later() {
    let (mut e, notes, _, note) = journal();
    fs::write(config_path(&e.vault), "{").unwrap();
    moved_outside(&mut e, "journal", "Diary");
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
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
    opened_after(&mut e);
    fs::write(config_path(&e.vault), daily("journal").to_string()).unwrap();
    make_day(&notes, &e, "2025-01-07");
    assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    std::thread::sleep(QUIET);
    e.drain();
    settles(&mut e, &notes, &note, "Diary");
}
