//! A journal setting change cut short (Step 13m-7b-2b, #3530): the change is recorded before its
//! first day moves, and the next open puts the days back, or forgets the record when the setting
//! was saved (`vault::journal_rename::finish_journal_change`). Each test runs on the app's own
//! identity (`NotesIdentity`) with two days and a note whose title is a date, and ends with every
//! day where the saved setting reads it, the note a note, no record deleted and no delete in the
//! outbox, through a day made later and three opens.
//!
//! | Test                                                              | Rule                                  |
//! | ----------------------------------------------------------------- | ------------------------------------- |
//! | a journal folder change killed at any step keeps every day        | recorded first, finished at open      |
//! | a journal format change killed at any step keeps every day        | the same, a note's row back           |
//! | a day cut off between its two steps keeps an outside edit         | the row back before the walk          |
//! | a journal change killed at any step keeps an edit made while the  | the rows back before the settings are |
//! | settings could not be read                                        | read                                  |
//! | a saved journal change's record leaves a file moved by hand alone | saved: the record only forgotten      |
//! | a refused journal change killed on its way back keeps every day   | the same record                       |
//! | a journal change cut short leaves no day where the setting is not | P2: a third folder after it           |
//! | a journal change cut short waits for readable settings            | the record waits, a day create ends it |
//! | a journal change whose days cannot go back holds the folder       | no folder move, no other change       |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::Arc;

use memry_core::domain::notes::journal_change::JournalChangeRecorded;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::config::settings::{SettingsError, update_vault_settings_checked};
use memry_desktop::vault::config::{VaultConfigPatch, config_path};
use memry_desktop::vault::journal_format::JournalDays;
use serde_json::Value;
use vault_env::{Env, QUIET};

use crate::journal_change::folder;
use crate::journal_folder::{
    DAY, crossed, daily, dated_note, make_day, outbox, quiet, reopen, row, try_day,
};
use crate::vault_settings::{opened_keeping, stored, update};

const DAY2: &str = "j2025-01-03";

/// The payload of a kill.
struct Killed;

/// A vault with two days and a dated note in `journal/`.
pub(crate) fn two_days() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>, String) {
    let (mut e, store) = opened_keeping(
        daily("journal"),
        &[
            ("journal/2025-01-02.md", "A day\n"),
            ("journal/2025-01-03.md", "Another day\n"),
        ],
    );
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let note = dated_note(&notes, &mut e);
    (e, notes, store, note)
}

fn format(to: &str) -> VaultConfigPatch {
    VaultConfigPatch {
        journal_date_format: Some(to.to_owned()),
        ..VaultConfigPatch::default()
    }
}

/// Runs the change `patch`, stopped at its step `kill_at` (from 1) as a crash stops it: nothing
/// after it runs. Answers how many steps ran and whether it was stopped.
pub(crate) fn change_killed(
    e: &Env,
    patch: VaultConfigPatch,
    kill_at: Option<usize>,
) -> (usize, bool) {
    let core = e.core();
    let mut at = 0;
    let result = catch_unwind(AssertUnwindSafe(|| {
        update_vault_settings_checked(&e.vault, Some((&core, &e.tier)), patch, |_| {}, &mut |_| {
            at += 1;
            if Some(at) == kill_at {
                resume_unwind(Box::new(Killed));
            }
        })
    }));
    match result {
        Ok(_) => (at, false),
        Err(payload) if payload.is::<Killed>() => (at, true),
        Err(payload) => resume_unwind(payload),
    }
}

fn record(e: &Env, store: &Arc<dyn SecureStore>) -> Option<JournalChangeRecorded> {
    let writer = e.core().notes_writer(store.clone()).unwrap();
    writer.pending_journal_change().unwrap()
}

/// The end every test here reaches: each day at the path the saved setting gives it, through a
/// day made later and three opens, the note kept, nothing deleted and no record left.
pub(crate) fn settled(e: &mut Env, notes: &NotesService, store: &Arc<dyn SecureStore>, note: &str) {
    reopen(e);
    assert_eq!(record(e, store), None);
    let saved = stored(&e.vault);
    let setting = |key: &str| saved[key].as_str().map(str::to_owned).unwrap();
    let days = JournalDays::new(&setting("journalFolder"), &setting("journalDateFormat"));
    make_day(notes, e, "2025-01-06");
    assert!(e.vault.join(days.path_of("2025-01-06").unwrap()).exists());
    reopen(e);
    reopen(e);
    let rows = e.rows();
    for (id, date) in [(DAY, "2025-01-02"), (DAY2, "2025-01-03")] {
        let at = days.path_of(date).unwrap();
        assert!(rows.contains(&row(id, &at)), "{rows:?}");
    }
    for id in [DAY, DAY2, note] {
        assert!(rows.iter().any(|(at, _)| at == id), "{id}: {rows:?}");
        assert!(!outbox(e, id).contains(&"delete".to_owned()), "{id}");
    }
}

/// Reopens after a kill: the open puts back or forgets, and makes and removes no note.
pub(crate) fn reopened(e: &mut Env) {
    e.close();
    e.drain();
    e.open();
    let facts = e.facts_until(vault_env::indexed);
    assert!(!crossed(&facts), "{facts:?}");
}

/// Runs `patch` once to count its steps, then on a new vault for each step, stopped there: the
/// next open puts the moved days back under the saved setting, or forgets the record of a saved
/// one, so every day stays a day.
fn killed_at_every_step(patch: &VaultConfigPatch) {
    let (e, ..) = two_days();
    let (steps, killed) = change_killed(&e, patch.clone(), None);
    assert!(!killed);
    drop(e);
    for kill_at in 1..=steps {
        let (mut e, notes, store, note) = two_days();
        let (_, killed) = change_killed(&e, patch.clone(), Some(kill_at));
        assert!(killed, "step {kill_at} of {steps}");
        reopened(&mut e);
        settled(&mut e, &notes, &store, &note);
    }
}

/// Recorded, each day's row moved, each day moved, the setting saved. The dated note stays.
#[test]
fn a_journal_folder_change_killed_at_any_step_keeps_every_day() {
    killed_at_every_step(&folder("Diary"));
}

/// The same for a date format change (#4011), whose pass also renames the dated note: a note
/// whose row moved and whose file did not takes its row back.
#[test]
fn a_journal_format_change_killed_at_any_step_keeps_every_day() {
    killed_at_every_step(&format("YYYY/YYYY-MM-DD dddd"));
}

/// Each step of a folder change and of a format change killed, then every journal file edited
/// while the app is closed and the settings unreadable at the next open: the record waits for
/// readable settings, but the open first takes back each row whose file never moved, so the walk
/// pairs every edited file with its record. Left to the walk, a day or the dated note cut off
/// between its two steps would be removed, its delete synced, and its file made a new note.
#[test]
fn a_journal_folder_change_killed_at_any_step_keeps_an_edit_made_while_unreadable() {
    killed_and_edited_while_unreadable(&folder("Diary"));
}

#[test]
fn a_journal_format_change_killed_at_any_step_keeps_an_edit_made_while_unreadable() {
    killed_and_edited_while_unreadable(&format("YYYY/YYYY-MM-DD dddd"));
}

fn killed_and_edited_while_unreadable(patch: &VaultConfigPatch) {
    let (e, ..) = two_days();
    let (steps, _) = change_killed(&e, patch.clone(), None);
    drop(e);
    for kill_at in 1..=steps {
        let (mut e, notes, store, note) = two_days();
        let (_, killed) = change_killed(&e, patch.clone(), Some(kill_at));
        assert!(killed, "step {kill_at} of {steps}");
        e.close();
        edit_every_file(&e.vault);
        let config: Value = stored(&e.vault);
        fs::write(config_path(&e.vault), "{").unwrap();
        reopened(&mut e);
        quiet(&mut e);
        fs::write(config_path(&e.vault), config.to_string()).unwrap();
        settled(&mut e, &notes, &store, &note);
        let rows = e.rows();
        for id in [DAY, DAY2, &note] {
            let (_, at) = rows.iter().find(|(row, _)| row == id).unwrap();
            assert!(e.read(at).ends_with(EDIT), "step {kill_at}: {id} at {at}");
        }
    }
}

const EDIT: &str = "Edited outside.\n";

/// Adds a line to every file of the vault outside its hidden folders.
fn edit_every_file(dir: &std::path::Path) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            edit_every_file(&path);
        } else {
            let text = fs::read_to_string(&path).unwrap();
            fs::write(&path, format!("{text}{EDIT}")).unwrap();
        }
    }
}

/// Stopped after the save, before its record was forgotten, and a day's file then moved back to
/// its old folder by hand, or replaced there by a file the app never wrote: the open forgets the
/// record of the saved change and leaves both files to the walk, as it would with no record. It
/// takes no row back to them, which would make a file outside the saved journal a day, or send
/// a stranger's text to every device as the day's edit.
#[test]
fn a_saved_journal_changes_record_leaves_a_file_moved_by_hand_alone() {
    let (e, ..) = two_days();
    let (steps, _) = change_killed(&e, folder("Diary"), None);
    drop(e);
    for replaced in [false, true] {
        let (mut e, ..) = two_days();
        let (_, killed) = change_killed(&e, folder("Diary"), Some(steps));
        assert!(killed);
        assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
        let edits = |e: &Env| {
            outbox(e, DAY)
                .iter()
                .filter(|op| *op == "crdt-update")
                .count()
        };
        let before = edits(&e);
        e.close();
        let (moved, old) = (
            e.vault.join("Diary/2025-01-02.md"),
            e.vault.join("journal/2025-01-02.md"),
        );
        if replaced {
            fs::remove_file(&moved).unwrap();
            fs::write(&old, "Unrelated\n").unwrap();
        } else {
            fs::rename(&moved, &old).unwrap();
        }
        e.drain();
        e.open();
        e.facts_until(vault_env::indexed);
        std::thread::sleep(QUIET);
        e.drain();
        assert!(
            !e.rows().contains(&row(DAY, "journal/2025-01-02.md")),
            "{replaced}"
        );
        assert_eq!(edits(&e), before, "{replaced}");
        assert_eq!(stored(&e.vault)["journalFolder"], "Diary");
    }
}

/// Stopped between a day's two steps (its row in the new folder, its file still in the old),
/// and the file edited before the next open: the open takes the row back to the file before its
/// walk, so the edit reaches the day. Left to the walk, the edited file pairs with no row, and
/// the day would be removed and a new one made.
#[test]
fn a_day_cut_off_between_its_two_steps_keeps_an_outside_edit() {
    let (mut e, notes, store, note) = two_days();
    // Recorded, the first day's row.
    let (_, killed) = change_killed(&e, folder("Diary"), Some(2));
    assert!(killed);
    assert!(e.rows().contains(&row(DAY, "Diary/2025-01-02.md")));
    e.close();
    fs::write(e.vault.join("journal/2025-01-02.md"), "Edited outside\n").unwrap();
    reopened(&mut e);
    quiet(&mut e);
    assert!(e.rows().contains(&row(DAY, "journal/2025-01-02.md")));
    assert_eq!(e.read("journal/2025-01-02.md"), "Edited outside\n");
    settled(&mut e, &notes, &store, &note);
}

/// A change refused because a day's new path is taken puts the moved days back; stopped on its
/// way back, at every step, the next open finishes the way back.
#[test]
fn a_refused_journal_change_killed_on_its_way_back_keeps_every_day() {
    let (mut e, ..) = two_days();
    e.write("Diary/2025-01-03.md", "A note\n");
    std::thread::sleep(QUIET);
    e.drain();
    let (steps, killed) = change_killed(&e, folder("Diary"), None);
    assert!(!killed);
    assert_eq!(stored(&e.vault)["journalFolder"], "journal");
    drop(e);
    for kill_at in 1..=steps {
        let (mut e, notes, store, note) = two_days();
        e.write("Diary/2025-01-03.md", "A note\n");
        std::thread::sleep(QUIET);
        e.drain();
        let (_, killed) = change_killed(&e, folder("Diary"), Some(kill_at));
        assert!(killed, "step {kill_at} of {steps}");
        reopened(&mut e);
        assert_eq!(stored(&e.vault)["journalFolder"], "journal");
        assert_eq!(e.read("Diary/2025-01-03.md"), "A note\n");
        settled(&mut e, &notes, &store, &note);
    }
}

/// Stopped after its first day moved (P2): the next open puts that day back, so a later change
/// to a third folder takes every day, and none is left in the folder the change was going to.
#[test]
fn a_journal_change_cut_short_leaves_no_day_where_the_setting_is_not() {
    let (mut e, notes, store, note) = two_days();
    // Recorded, the first day's row, the first day.
    let (_, killed) = change_killed(&e, folder("Diary"), Some(3));
    assert!(killed);
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    reopened(&mut e);
    assert!(!e.vault.join("Diary").exists());
    update(&e, folder("Other"), |_| {}).unwrap();
    assert!(!e.vault.join("Diary").exists());
    settled(&mut e, &notes, &store, &note);
    assert_eq!(stored(&e.vault)["journalFolder"], "Other");
}

/// The same, and the next open cannot read the settings: the record waits, and no day is made
/// meanwhile. Once the settings read again, the next day made puts the moved day back first.
#[test]
fn a_journal_change_cut_short_waits_for_readable_settings() {
    let (mut e, notes, store, note) = two_days();
    let (_, killed) = change_killed(&e, folder("Diary"), Some(3));
    assert!(killed);
    let config: Value = stored(&e.vault);
    fs::write(config_path(&e.vault), "{").unwrap();
    reopened(&mut e);

    assert!(matches!(
        record(&e, &store),
        Some(JournalChangeRecorded::Change(_))
    ));
    let refused = try_day(&notes, &e, "2025-01-07");
    assert!(
        matches!(refused, Err(NotesError::SettingsUnreadable(_))),
        "{refused:?}"
    );
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    fs::write(config_path(&e.vault), config.to_string()).unwrap();
    make_day(&notes, &e, "2025-01-07");
    assert!(e.vault.join("journal/2025-01-07.md").exists());
    assert!(e.vault.join("journal/2025-01-02.md").exists());
    assert_eq!(record(&e, &store), None);
    std::thread::sleep(QUIET);
    e.drain();
    settled(&mut e, &notes, &store, &note);
}

/// The moved day cannot go back (a folder took its old path while the app was closed): the
/// record waits, and while it does no folder move takes the folder its day is in and no other
/// journal change starts. Once the path is free, the next open puts the day back.
#[test]
fn a_journal_change_whose_days_cannot_go_back_holds_the_folder() {
    let (mut e, notes, store, note) = two_days();
    let (_, killed) = change_killed(&e, folder("Diary"), Some(3));
    assert!(killed);
    e.close();
    fs::create_dir(e.vault.join("journal/2025-01-02.md")).unwrap();
    e.drain();
    e.open();
    e.facts_until(vault_env::indexed);
    quiet(&mut e);

    assert!(matches!(
        record(&e, &store),
        Some(JournalChangeRecorded::Change(_))
    ));
    let open = e.session.current().unwrap();
    let moved = notes.rename_folder(&open, "Diary", "Old", |_| panic!("announced"));
    assert!(
        matches!(moved, Err(NotesError::JournalChangeWaits)),
        "{moved:?}"
    );
    drop(open);
    let refused = update(&e, folder("Other"), |_| panic!("announced"));
    assert!(
        matches!(refused, Err(SettingsError::ChangeWaits)),
        "{refused:?}"
    );
    assert!(e.vault.join("Diary/2025-01-02.md").exists());
    assert!(!crossed(&e.drain()));

    fs::remove_dir(e.vault.join("journal/2025-01-02.md")).unwrap();
    quiet(&mut e);
    reopened(&mut e);
    assert!(e.vault.join("journal/2025-01-02.md").is_file());
    settled(&mut e, &notes, &store, &note);
}
